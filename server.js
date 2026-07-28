const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

let users = [];
let messages = [];

// ROTA: REGISTRO
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ status: 'error', message: 'Dados incompletos' });
    if (users.find(u => u.username === username)) return res.status(400).json({ status: 'error', message: 'USUÁRIO_JÁ_REGISTRADO' });
    users.push({ username, password });
    res.status(201).json({ status: 'ok' });
});

// ROTA: LOGIN
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ status: 'error', message: 'NÃO_ENCONTRADO' });
    if (user.password === password) res.status(200).json({ status: 'ok' });
    else res.status(401).json({ status: 'error', message: 'SENHA_INCORRETA' });
});

// ROTA: ENVIAR MENSAGEM
app.post('/send_message', (req, res) => {
    const { username, recipient, content } = req.body;
    const msg = {
        id: Date.now(),
        from: username,
        to: recipient,
        content,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        read: false
    };
    messages.push(msg);
    res.status(200).json({ status: 'enviada' });
});

// ROTA: BUSCAR CONVERSA COMPLETA (Histórico)
app.get('/conversation/:user1/:user2', (req, res) => {
    const { user1, user2 } = req.params;
    const chat = messages.filter(m =>
        (m.from === user1 && m.to === user2) ||
        (m.from === user2 && m.to === user1)
    );
    res.json(chat);
});

// ROTA: MARCAR COMO LIDA
app.post('/mark_read', (req, res) => {
    const { username, contact } = req.body;
    messages.forEach(m => {
        if (m.from === contact && m.to === username) {
            m.read = true;
        }
    });
    res.status(200).json({ status: 'ok' });
});

// Limpar Caixa
app.post('/clear_messages', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        messages = messages.filter(m => m.to !== username);
        res.status(200).json({ status: 'ok' });
    } else res.status(401).send('Acesso negado');
});

app.get('/', (req, res) => res.send('CyberServer v3.0 Ativo!'));
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
