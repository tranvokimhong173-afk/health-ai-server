// Trong healthDataListener.js

// SỬA ĐỔI QUAN TRỌNG: Import cả db (RTDB) và firestore
const { db, firestore } = require('../firebase'); 

// Import services và AI Modules
const sendAlertEmail = require('../services/emailService'); 
const { learnAndSaveBaseline } = require('../ai/baselineLearner'); // Module học Baseline
const { analyzePersonalPattern, predictNextValue } = require('../aiModule'); // Module AI chính

// BỔ SUNG: Import hàm phân tích giấc ngủ và phân tích dài hạn
const { analyzeAndSaveSleepSummary } = require('../ai/sleepAnalyzer'); 
const { analyzeLongTermTrends, getWeekIdentifier } = require('../ai/longTermAnalyzer'); // Nhiệm vụ 3

console.log("🔍 Listening for health data changes at: healthData/device1");

// --- 1. HÀM HỖ TRỢ DB ---

/**
 * Lưu cảnh báo vào RTDB (lịch sử) và Firestore (live alerts).
 * @param {string} deviceID 
 * @param {object} alertData 
 */
async function saveAlert(deviceID, alertData) {
    const timestamp = Date.now();
    try {
        // 1. LƯU VÀO RTDB (Giữ nguyên cho backup/lịch sử đầy đủ)
        await db.ref(`history/${deviceID}/alerts/${timestamp}`).set(alertData);
        console.log(`📝 Alert saved to history/alerts (RTDB) for ${deviceID}.`);
        
        // 2. GHI VÀO FIRESTORE ĐỂ WEB/APP NHẬN ĐƯỢC
        const alertDoc = {
            // Lấy loại cảnh báo đầu tiên
            type: alertData.alerts[0]?.type || "warning", 
            // Ghép tất cả các thông điệp cảnh báo
            message: alertData.alerts.map(a => a.message || a).join(" | "), 
            // Sử dụng định dạng ISO String
            timestamp: new Date(timestamp).toISOString(), 
            deviceID: deviceID,
            riskScore: alertData.riskScore,
            dataContext: alertData.dataContext
        };
        
        await firestore.collection('alerts').add(alertDoc);
        console.log(`✅ Alert saved to Firestore for ${deviceID}.`);
        
    } catch (error) {
        console.error(`❌ ERROR in saveAlert for ${deviceID}:`, error);
    }
}

async function get7DaysHistory(deviceID) {
    const RECORDS_PATH = `history/${deviceID}/records`;
    // Tính toán timestamp 7 ngày trước
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000; 
    try {
        const snapshot = await db.ref(RECORDS_PATH)
            .orderByKey()
            .startAt(sevenDaysAgo.toString())
            .once('value');
            
        const data = snapshot.val();
        
        // Chuyển object thành mảng, thêm timestamp key vào object
        return data ? Object.keys(data).map(key => ({
            ...data[key],
            timestamp: key 
        })) : [];

    } catch (error) {
        console.error(`❌ ERROR in get7DaysHistory for ${deviceID}:`, error);
        return [];
    }
}

async function getLastNHistory(deviceID, n = 50) {
    const RECORDS_PATH = `history/${deviceID}/records`;
    try {
        const snapshot = await db.ref(RECORDS_PATH).orderByKey().limitToLast(n).once('value');
        const data = snapshot.val();
        // Lấy 50 bản ghi gần nhất cho phân tích tức thì
        return data ? Object.values(data) : []; 
    } catch (error) {
        console.error(`❌ ERROR in getLastNHistory for ${deviceID}:`, error);
        return [];
    }
}

async function getUserProfile(deviceID) {
    try {
        const snapshot = await db.ref(`userProfile/${deviceID}`).once('value');
        const profile = snapshot.val() || {};
        return {
            age: profile.age || 30,
            underlyingConditions: profile.underlyingConditions || {}
        };
    } catch (error) {
        console.error(`❌ ERROR in getUserProfile for ${deviceID}:`, error);
        return { age: 30, underlyingConditions: {} };
    }
}

async function saveHistory(deviceID, data) {
    const timestamp = Date.now();
    let removedCount = 0; 
    const RECORDS_PATH = `history/${deviceID}/records`; 

    try {
        const historyRef = db.ref(RECORDS_PATH);
        const newRecordKey = timestamp.toString();
        let updates = { [newRecordKey]: data };
        
        const sevenDaysAgo = timestamp - 7 * 24 * 60 * 60 * 1000;
        
        // Truy vấn các bản ghi cũ hơn 7 ngày
        const snapshot = await historyRef
            .orderByKey()
            .endAt(sevenDaysAgo.toString())
            .once('value');
            
        const oldData = snapshot.val();

        if (oldData) {
            for (let key in oldData) {
                if (parseInt(key) <= sevenDaysAgo) { 
                    updates[key] = null; // Đánh dấu xóa
                    removedCount++;
                }
            }
        }
        
        // Thực hiện thêm bản ghi mới và xóa bản ghi cũ trong 1 lần ghi (Multi-path Update)
        await historyRef.update(updates); 
        
        console.log(`✅ Completed DB update for ${deviceID}. (Added 1, Removed ${removedCount})`);

    } catch (error) {
        console.error(`❌ ERROR in saveHistory for ${deviceID}:`, error);
    }
}


// --- HÀM BỔ SUNG: KIỂM TRA NGƯỠNG VẬT LÝ CƠ BẢN (KHÔNG CẦN LỊCH SỬ) ---

/**
 * Kiểm tra các ngưỡng vật lý cơ bản (hard-coded) cho dữ liệu mới nhất.
 * @param {string} deviceID ID thiết bị
 * @param {object} data Dữ liệu sức khỏe mới nhất (ví dụ: {bpm: 150, temp: 40.5})
 * @returns {object|null} Đối tượng cảnh báo nếu vượt ngưỡng, ngược lại null.
 */
function checkPhysicalThresholds(deviceID, data) {
    const alerts = [];
    let isCritical = false;

    // Ngưỡng vật lý cơ bản (có thể điều chỉnh)
    const MAX_BPM = 150; // Quá cao
    const MIN_BPM = 40;  // Quá thấp
    const MAX_TEMP = 40.0; // Sốt cao
    const MIN_TEMP = 35.0; // Hạ thân nhiệt

    if (data.bpm && (data.bpm > MAX_BPM || data.bpm < MIN_BPM)) {
        alerts.push({
            type: "PhysicalThreshold",
            metric: "BPM",
            value: data.bpm,
            threshold: data.bpm > MAX_BPM ? `> ${MAX_BPM}` : `< ${MIN_BPM}`,
            message: `Nhịp tim (${data.bpm} bpm) vượt ngưỡng an toàn nghiêm trọng!`
        });
        isCritical = true;
    }

    if (data.temp && data.temp > MAX_TEMP) {
        alerts.push({
            type: "PhysicalThreshold",
            metric: "Temperature",
            value: data.temp,
            threshold: `> ${MAX_TEMP}°C`,
            message: `Nhiệt độ cơ thể (${data.temp}°C) vượt ngưỡng sốt cao nghiêm trọng!`
        });
        isCritical = true;
    }
    
    // Thêm kiểm tra hạ thân nhiệt, tùy theo yêu cầu
    if (data.temp && data.temp < MIN_TEMP) {
        alerts.push({
            type: "PhysicalThreshold",
            metric: "Temperature",
            value: data.temp,
            threshold: `< ${MIN_TEMP}°C`,
            message: `Nhiệt độ cơ thể (${data.temp}°C) dưới ngưỡng hạ thân nhiệt nghiêm trọng!`
        });
        isCritical = true;
    }

    if (alerts.length > 0) {
        return {
            risk: isCritical ? 100 : 80, // Điểm rủi ro cao cho ngưỡng vật lý
            alerts: alerts,
            isPhysicalAlert: true // Dấu hiệu để biết đây là cảnh báo vật lý
        };
    }

    return null;
}


// --- 2. LISTENER CHÍNH (Xử lý Luồng Dữ liệu) ---

const ref = db.ref('healthData/device1'); 

ref.on('value', async (snapshot) => {
    try {
        const deviceID = snapshot.key; 
        const data = snapshot.val();

        if (!data || Object.keys(data).length === 0) return; 

        console.log(`\n📥 New data from ${deviceID}:`, data);

        // 1. LƯU DỮ LIỆU TỨC THỜI VÀO LỊCH SỬ (records)
        await saveHistory(deviceID, data);

        // BỔ SUNG: KIỂM TRA NGƯỠNG VẬT LÝ TRƯỚC HẾT
        const physicalAlert = checkPhysicalThresholds(deviceID, data);

        if (physicalAlert) {
            console.log("🚨 CẢNH BÁO VẬT LÝ NGHIÊM TRỌNG ĐƯỢC KÍCH HOẠT!");
            await saveAlert(deviceID, {
                timestamp: Date.now(),
                riskScore: physicalAlert.risk,
                alerts: physicalAlert.alerts, 
                dataContext: data 
            });
            // Gửi email ngay lập tức
            await sendAlertEmail(deviceID, data, physicalAlert); 
            console.log(`📧 Successfully triggered physical alert email.`);
            
            // DỪNG xử lý AI nếu đã có cảnh báo vật lý nghiêm trọng
            return; 
        }

        // 2. TẢI DỮ LIỆU CẦN THIẾT
        const history = await getLastNHistory(deviceID, 50); // Lịch sử gần nhất cho phân tích tức thì
        const { age, underlyingConditions } = await getUserProfile(deviceID);
        
        // 3. TÍCH HỢP HỌC BASELINE (Chỉ chạy định kỳ)
        if (history.length > 10 && Math.random() < 0.1) { 
            const longTermHistory = await get7DaysHistory(deviceID); 
            if (longTermHistory.length > 100) {
                 console.log("⏳ Bắt đầu Học và Cập nhật Baseline...");
                 await learnAndSaveBaseline(deviceID, longTermHistory); 
            }
        }

        // 4. PHÂN TÍCH BẰNG AI CHÍNH (Cảnh báo tức thì - Chỉ chạy nếu không có cảnh báo vật lý)
        const analysis = analyzePersonalPattern(data, history, age, underlyingConditions); 

        // 5. CẢNH BÁO VÀ GHI LỊCH SỬ CẢNH BÁO
        if (analysis.alerts && analysis.alerts.length > 0) {
            const alertDataToSave = {
                timestamp: Date.now(),
                riskScore: analysis.risk,
                alerts: analysis.alerts, 
                dataContext: data 
            };
            await saveAlert(deviceID, alertDataToSave);
            await sendAlertEmail(deviceID, data, analysis); 
            console.log(`📧 Successfully triggered AI alert email.`);
        }

        const nextBpm = predictNextValue(history, "bpm");
        const nextTemp = predictNextValue(history, "temp");

        console.log(`📊 Device: ${deviceID} | Risk Score: ${analysis.risk}/100`);
        console.log(`🔮 Next BPM: ${nextBpm} | Next Temp: ${nextTemp}`);

        // =========================================================
        // 6. PHÂN TÍCH GIẤC NGỦ (Nhiệm vụ 2)
        // =========================================================
        const currentDate = new Date();
        const currentHour = currentDate.getHours();
        
        // Kích hoạt Phân tích Giấc ngủ một lần vào buổi sáng (ví dụ: 6h-7h)
        if (currentHour >= 6 && currentHour <= 7 && data.isResting === false) { 
            const summaryDate = currentDate.toISOString().split('T')[0];
            
            // Tránh chạy phân tích nhiều lần trong cùng một ngày
            const checkRef = db.ref(`history/${deviceID}/sleep_summaries/${summaryDate}`);
            const summarySnapshot = await checkRef.once('value');

            if (!summarySnapshot.exists()) {
                console.log("💤 Bắt đầu Phân tích Giấc ngủ Đêm qua...");
                const endTime = currentDate.getTime();
                await analyzeAndSaveSleepSummary(deviceID, endTime, 8); 
            }
        }
        
        // =========================================================
        // 7. BÁO CÁO HÀNG TUẦN (Nhiệm vụ 3)
        // =========================================================
        const currentDayOfWeek = currentDate.getDay(); // 0 là Chủ nhật, 6 là Thứ bảy
        const targetRunHour = 10; // Chạy lúc 10 giờ sáng

        // CHỈ CHẠY VÀO CHỦ NHẬT VÀ TRONG KHOẢNG 10H-11H SÁNG
        if (currentDayOfWeek === 0 && currentHour === targetRunHour) { 
            const currentWeekId = getWeekIdentifier(currentDate);
            const weeklyRef = db.ref(`history/${deviceID}/weekly_summaries/${currentWeekId}`);
            const weeklySnapshot = await weeklyRef.once('value');

            if (!weeklySnapshot.exists()) {
                console.log("\n📰 Bắt đầu tạo Báo cáo Sức khỏe Hàng tuần...");
                await analyzeLongTermTrends(deviceID, currentDate);
            } else {
                console.log(`Báo cáo tuần ${currentWeekId} đã tồn tại. Bỏ qua.`);
            }
        }
        // =========================================================


    } catch (error) {
        console.error(`🔴 CRITICAL ERROR in healthData listener:`, error);
    }
});

console.log("✅ Listener for device1 is running...");

// XUẤT CÁC HÀM HỖ TRỢ ĐỂ FILE TEST CÓ THỂ GỌI ĐƯỢC
module.exports = { 
    saveHistory, 
    get7DaysHistory, 
    saveAlert, 
    getLastNHistory,
    getUserProfile,
    checkPhysicalThresholds, // Bổ sung export để test
    // Export các hàm AI cho mục đích test
    analyzeAndSaveSleepSummary: require('../ai/sleepAnalyzer').analyzeAndSaveSleepSummary,
    analyzeLongTermTrends: require('../ai/longTermAnalyzer').analyzeLongTermTrends
};