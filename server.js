const express = require('express');
const bodyParser = require('body-parser');
const { analyzePersonalPattern, predictNextValue } = require('./aiModule');

const app = express();
app.use(bodyParser.json());

app.post('/api/analyze', async (req, res) => {
    try {
        const { data, history, age, underlyingConditions } = req.body;
        const result = analyzePersonalPattern(data, history, age, underlyingConditions);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
