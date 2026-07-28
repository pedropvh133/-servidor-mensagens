const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
// Aumentar o limite para suportar áudio em Base64
app.use(bodyParser.json({ limit: '10mb' }));

let users = []; // [{ username, password, lastSeen }]
let messages = [];

// Helper: Atualiza o status do usuário
function updateSeen(username) {
    const user = users.find(u => u.username === username);
    if (user) user.lastSeen = Date.now();
}

// ROTA: REGISTRO
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ status: 'error', message: 'Dados incompletos' });
    if (users.find(u => u.username === username)) return res.status(400).json({ status: 'error', message: 'USUÁRIO_JÁ_REGISTRADO' });
    users.push({ username, password, lastSeen: Date.now() });
    res.status(201).json({ status: 'ok' });
});

// ROTA: LOGIN
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ status: 'error', message: 'NÃO_ENCONTRADO' });
    if (user.password === password) {
        user.lastSeen = Date.now();
        res.status(200).json({ status: 'ok' });
    } else res.status(401).json({ status: 'error', message: 'SENHA_INCORRETA' });
});

// ROTA: STATUS ONLINE
app.get('/status/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.json({ status: 'OFFLINE' });

    const secondsAgo = (Date.now() - user.lastSeen) / 1000;
    if (secondsAgo < 20) {
        res.json({ status: 'ONLINE' });
    } else {
        const date = new Date(user.lastSeen);
        const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        res.json({ status: `VISTO ÚLTIMA VEZ ${time}` });
    }
});

// ROTA: ENVIAR MENSAGEM (TEXTO OU ÁUDIO)
app.post('/send_message', (req, res) => {
    const { username, recipient, content, isAudio, viewOnce } = req.body;
    updateSeen(username);
    const msg = {
        id: Date.now(),
        from: username,
        to: recipient,
        content,
        isAudio: isAudio || false,
        viewOnce: viewOnce || false,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        read: false
    };
    messages.push(msg);
    res.status(200).json({ status: 'enviada' });
});

// ROTA: BUSCAR CONVERSA
app.get('/conversation/:user1/:user2', (req, res) => {
    updateSeen(req.params.user1);
    const { user1, user2 } = req.params;
    const chat = messages.filter(m =>
        (m.from === user1 && m.to === user2) ||
        (m.from === user2 && m.to === user1)
    );
    res.json(chat);
});

// ROTA: DESTRUIR MENSAGEM (Para Visualização Única)
app.post('/destroy_message', (req, res) => {
    const { messageId, username } = req.body;
    const index = messages.findIndex(m => m.id === messageId && m.to === username);
    if (index !== -1) {
        messages.splice(index, 1);
        res.status(200).json({ status: 'destroyed' });
    } else res.status(404).send('Não encontrada');
});

// ROTA: MARCAR COMO LIDA
app.post('/mark_read', (req, res) => {
    const { username, contact } = req.body;
    updateSeen(username);
    messages.forEach(m => {
        if (m.from === contact && m.to === username) m.read = true;
    });
    res.status(200).json({ status: 'ok' });
});

app.get('/', (req, res) => res.send('CyberServer v5.0 (Status + Áudio) Ativo!'));
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
