// emailService.js
const nodemailer = require('nodemailer'); 

// 2. Lấy biến môi trường (Environment Variables)
const HOST = "smtp.gmail.com"; 
const PORT = 587; 
const USER = process.env.EMAIL_USER; 
const PASS = process.env.EMAIL_PASS; 
const ALERT_EMAIL = process.env.ALERT_EMAIL_TO; // Địa chỉ người nhận

// 3. Khởi tạo Transporter
const transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: false, // Dùng false cho port 587 (STARTTLS)
    auth: {
        user: USER,
        pass: PASS,
    },
});

// Hàm trợ giúp tạo danh sách cảnh báo (alerts) HTML
function generateAlertList(alerts) {
    if (!alerts || alerts.length === 0) {
        return '<p style="font-size: 15px; color: #777; margin: 0;">Không có cảnh báo chi tiết.</p>';
    }

    const listItems = alerts.map(alert => `
        <li style="margin-bottom: 8px; font-size: 15px; color: #333; line-height: 1.5;">
            ${alert}
        </li>
    `).join('');

    return `
        <ul style="padding-left: 20px; margin: 0;">
            ${listItems}
        </ul>
    `;
}


/**
 * Hàm gửi email cảnh báo
 * @param {string} deviceID ID thiết bị
 * @param {object} data Dữ liệu sức khỏe hiện tại
 * @param {object} analysis Kết quả phân tích (cần có analysis.risk, analysis.alerts, isPhysicalAlert)
 */
async function sendAlertEmail(deviceID, data, analysis) {
    
    // Kiểm tra cấu hình bắt buộc
    if (!ALERT_EMAIL || !USER || !PASS) {
        console.warn('⚠️ Cảnh báo: Email bị bỏ qua do thiếu cấu hình GỬI HOẶC NHẬN.');
        console.warn(`EMAIL_USER: ${!!USER}, EMAIL_PASS: ${!!PASS}, ALERT_EMAIL_TO: ${!!ALERT_EMAIL}`);
        return;
    }

    try {
        // --- 1. KHẮC PHỤC LỖI Subject (analysis.risk) & Dữ liệu mặc định (SUPER ROBUST) ---
        let determinedRisk = 0;
        if (analysis && analysis.risk !== undefined) {
            if (typeof analysis.risk === 'number') {
                determinedRisk = analysis.risk;
            } else if (typeof analysis.risk === 'string') {
                // Cố gắng parse chuỗi thành số (ví dụ: nếu '60' được truyền vào)
                const parsedRisk = parseInt(analysis.risk, 10);
                if (!isNaN(parsedRisk)) {
                    determinedRisk = parsedRisk;
                }
            }
        }
        const riskScore = determinedRisk;
        
        const alerts = analysis && Array.isArray(analysis.alerts) ? analysis.alerts : [];
        const isPhysicalAlert = analysis.isPhysicalAlert === true;
        
        // --- 2. Logic xác định màu sắc và nội dung cảnh báo ---
        let riskColor = '#4CAF50'; // Green Dịu
        let riskBgColor = '#E8F5E9'; // Light Green
        
        if (riskScore >= 80 || isPhysicalAlert) { 
            riskColor = '#D32F2F'; // Deep Red
            riskBgColor = '#FFEBEE'; // Light Red
        } else if (riskScore >= 50) {
            riskColor = '#FB8C00'; // Orange Dịu
            riskBgColor = '#FFF3E0'; // Light Orange
        } else if (riskScore >= 20) {
            riskColor = '#FBC02D'; // Yellow Dịu
            riskBgColor = '#FFFDE7'; // Light Yellow
        }
        
        const defaultRiskText = riskScore >= 80 ? 'RỦI RO RẤT CAO' : riskScore >= 50 ? 'RỦI RO TRUNG BÌNH' : 'CẦN THEO DÕI';
        const riskText = analysis.riskText || (isPhysicalAlert ? 'CẢNH BÁO VẬT LÝ NGHIÊM TRỌNG' : defaultRiskText);
        
        // 🚨 KHẮC PHỤC LỖI Cannot read properties of undefined (reading 'status') và N/A
        const fallStatus = data.fall && data.fall.status ? data.fall.status : 'Không rõ';
        const fallColor = (data.fall && data.fall.status === 'Đã té ngã') ? riskColor : '#4CAF50';

        const mailOptions = {
            from: `"Health Monitor" <${USER}>`,
            to: ALERT_EMAIL, 
            // Sử dụng riskScore đã được kiểm tra an toàn
            subject: `⚠️ Cảnh báo sức khỏe cho thiết bị ${deviceID} (${riskScore}/100)`,
            html: `
<div style="font-family: 'Segoe UI', Tahoma, sans-serif; background-color: #f4f7fb; padding: 25px;">
    <table style="width: 100%; max-width: 620px; margin: auto; background: #ffffff; border-radius: 14px; box-shadow: 0 8px 25px rgba(0,0,0,0.08); overflow: hidden;">

                <tr>
            <td style="background-color: ${riskColor}; color: white; padding: 22px; text-align: center;">
                <h1 style="margin: 0; font-size: 26px; font-weight: 700;">
                    ${riskScore >= 80 || isPhysicalAlert ? '🚨' : '⚠️'} CẢNH BÁO SỨC KHỎE
                </h1>
                <p style="margin: 6px 0 0; font-size: 15px; opacity: 0.9;">Thiết bị: ${deviceID}</p>
            </td>
        </tr>

                <tr>
            <td style="padding: 30px 28px;">
                <p style="font-size: 16px; color: #333; line-height: 1.6;">Xin chào,</p>
                <p style="font-size: 16px; color: #333; margin-bottom: 24px; line-height: 1.7;">
                    Hệ thống giám sát sức khỏe <b>Health Monitor</b> phát hiện mức độ: 
                    <b style="color: ${riskColor};">${riskText}</b>.  
                    Vui lòng kiểm tra ngay lập tức.
                </p>

                                <div style="background-color: ${riskBgColor}; padding: 18px; border-radius: 10px; border-left: 6px solid ${riskColor}; margin-bottom: 32px;">
                    <p style="font-size: 17px; font-weight: 700; color: ${riskColor}; margin: 0 0 5px;">MỨC ĐỘ RỦI RO</p>
                    <p style="font-size: 22px; font-weight: 700; margin: 6px 0;">${riskText}</p>
                    <p style="font-size: 14px; margin: 0; color: #444;">Điểm đánh giá: <b>${riskScore}/100</b></p>
                </div>

                <div style="margin-bottom: 30px; padding: 15px; border-radius: 10px; background-color: #f7f9fc; border: 1px solid #e0e0e0;">
                    <p style="font-size: 17px; font-weight: 600; color: #444; margin-top: 0;">🔎 Lý do Chi tiết:</p>
                    ${generateAlertList(alerts)}
                </div>

                                <p style="font-size: 17px; font-weight: 600; color: #444; margin-bottom: 15px;">Dữ liệu hiện tại</p>
                <table style="width: 100%; border: 1px solid #e0e0e0; border-radius: 10px; overflow: hidden; border-collapse: collapse;">
                    <thead>
                        <tr style="background: #eef1f5;">
                            <th style="padding: 12px; text-align: left; font-size: 14px; color: #555;">Thông số</th>
                            <th style="padding: 12px; text-align: right; font-size: 14px; color: #555;">Giá trị</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td style="padding: 12px; border-bottom: 1px solid #eee; font-size: 15px;">Nhịp tim</td>
                            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 15px; font-weight: 600; color: #007bff;">
                                ${data.bpm || 'N/A'} bpm
                            </td>
                        </tr>
                        <tr style="background: #fafafa;">
                            <td style="padding: 12px; border-bottom: 1px solid #eee; font-size: 15px;">Nhiệt độ cơ thể</td>
                            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 15px; font-weight: 600; color: #007bff;">
                                ${data.temp || 'N/A'} °C
                            </td>
                        </tr>
                        <tr>
                            <td style="padding: 12px; font-size: 15px;">Trạng thái té ngã</td>
                            <td style="padding: 12px; text-align: right; font-size: 15px; font-weight: 700; color: ${fallColor};">
                                ${fallStatus}
                            </td>
                        </tr>
                    </tbody>
                </table>

                                <div style="text-align: center; margin-top: 38px;">
                    <a href="#" 
                        style="padding: 14px 36px; background-color: #007bff; color: white; 
                        text-decoration: none; font-size: 16px; font-weight: 700; border-radius: 10px;
                        box-shadow: 0 6px 18px rgba(0,123,255,0.35); display: inline-block;">
                        🚀 Xem chi tiết trên Dashboard
                    </a>
                </div>

                <p style="text-align: center; margin-top: 35px; font-size: 14px; color: #777;">
                    *Dữ liệu thời gian thực – vui lòng kiểm tra thiết bị khi có cảnh báo.
                </p>
            </td>
        </tr>

                <tr>
            <td style="padding: 16px; background-color: #eef1f5; text-align: center; font-size: 12px; color: #888;">
                Đây là email cảnh báo tự động – vui lòng không phản hồi.<br>
                © 2025 – Hệ thống Health Monitor
            </td>
        </tr>
    </table>
</div>
`

        };

        let info = await transporter.sendMail(mailOptions);
        
        console.log(`📧 Sent alert email: ${info.messageId} | Subject: ${mailOptions.subject}`);
        
        return info;

    } catch (error) {
        // Bắt lỗi chi tiết hơn (EAUTH/Connection)
        console.error('❌ Critical error sending alert email (EAUTH/Connection):', error.message);
        // Ném lỗi mới để server.js (hoặc hàm gọi) không bị crash vô ích
        throw new Error(`Lỗi gửi email: ${error.code || 'UNKNOWN'} - ${error.message}`); 
    }
}

module.exports = { sendAlertEmail };