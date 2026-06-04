const express = require('express');
const app = express();
const PORT = 3000;

// Set EJS as the template engine
app.set('view engine', 'ejs');

// Serve static files from the public directory
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.render('index', { 
        username: 'User', 
        date: new Date().toLocaleDateString() 
    });
});

app.get('/waitingView', (req, res) => {
    res.render('waitingView', { 
        username: 'User', 
        date: new Date().toLocaleDateString() 
    });
});

app.get('/installation-explanation', (req, res) => {
    res.render('installationExplanation');
});

if (require.main === module) {
    app.listen(process.env.PORT || PORT, () => {
        console.log(`Server running at http://localhost:${process.env.PORT || PORT}`);
    });
}

module.exports = app;