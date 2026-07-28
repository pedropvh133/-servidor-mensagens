const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '30mb' })); // Limite aumentado para mídia de alta qualidade

let users = [];
let messages = [];

function updateSeen(username) {
    const user = users.find(u => u.username === username);
    if (user) user.lastSeen = Date.now();
}

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Dados incompletos' });
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });
    users.push({ username, password, lastSeen: Date.now() });
    res.status(201).json({ status: 'ok' });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'NÃO_ENCONTRADO' });
    if (user.password === password) {
        user.lastSeen = Date.now();
        res.status(200).json({ status: 'ok' });
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

app.get('/status/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.json({ status: 'OFFLINE' });
    const secondsAgo = (Date.now() - user.lastSeen) / 1000;
    if (secondsAgo < 20) res.json({ status: 'ONLINE' });
    else res.json({ status: `Visto por último ${new Date(user.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` });
});

app.post('/send_message', (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce } = req.body;
    updateSeen(username);
    const msg = {
        id: Date.now(),
        from: username,
        to: recipient,
        content,
        isAudio: isAudio || false,
        isImage: isImage || false,
        isVideo: isVideo || false,
        viewOnce: viewOnce || false,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        read: false
    };
    messages.push(msg);
    res.status(200).json({ status: 'ok' });
});

app.get('/conversation/:user1/:user2', (req, res) => {
    updateSeen(req.params.user1);
    const { user1, user2 } = req.params;
    const chat = messages.filter(m =>
        (m.from === user1 && m.to === user2) ||
        (m.from === user2 && m.to === user1)
    );
    res.json(chat);
});

// NOVA ROTA: APAGAR PARA TODOS
app.post('/delete_message', (req, res) => {
    const { messageId, username } = req.body;
    const index = messages.findIndex(m => m.id === messageId && m.from === username);
    if (index !== -1) {
        messages.splice(index, 1);
        res.status(200).json({ status: 'ok', message: 'Apagada para todos' });
    } else {
        res.status(404).json({ error: 'Mensagem não encontrada ou você não é o autor' });
    }
});

app.post('/destroy_view_once', (req, res) => {
    const { messageId, username } = req.body;
    const index = messages.findIndex(m => m.id === messageId && m.to === username);
    if (index !== -1) {
        messages.splice(index, 1);
        res.status(200).json({ status: 'ok' });
    } else res.status(404).send('Não encontrada');
});

app.post('/mark_read', (req, res) => {
    const { username, contact } = req.body;
    updateSeen(username);
    messages.forEach(m => {
        if (m.from === contact && m.to === username) m.read = true;
    });
    res.status(200).json({ status: 'ok' });
});

app.post('/clear_messages', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        messages = messages.filter(m => m.to !== username);
        res.status(200).json({ status: 'ok' });
    } else res.status(401).send('Negado');
});

app.get('/', (req, res) => res.send('Midnight CyberServer v7.0 Ativo!'));
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
