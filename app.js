const express = require('express');
const app = express();
const PORT = 3000;

// Set EJS as the template engine
app.set('view engine', 'ejs');

app.get('/', (req, res) => {
    res.render('index', { 
        username: 'User', 
        date: new Date().toLocaleDateString() 
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});