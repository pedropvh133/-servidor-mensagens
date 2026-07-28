const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '30mb' }));

let users = []; // [{ username, password, lastSeen, profilePic, privacyLastSeen, privacyProfilePic }]
let messages = [];
let groups = [];
let callSignals = {};

function updateSeen(username) {
    const user = users.find(u => u.username === username);
    if (user) user.lastSeen = Date.now();
}

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Dados incompletos' });
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });

    users.push({
        username,
        password,
        lastSeen: Date.now(),
        profilePic: null,
        privacyLastSeen: 'Todos',
        privacyProfilePic: 'Todos'
    });
    res.status(201).json({ status: 'ok' });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'NÃO_ENCONTRADO' });
    if (user.password === password) {
        user.lastSeen = Date.now();
        res.status(200).json({
            status: 'ok',
            profilePic: user.profilePic,
            privacyLastSeen: user.privacyLastSeen,
            privacyProfilePic: user.privacyProfilePic
        });
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

app.post('/user/update_settings', (req, res) => {
    const { username, currentPassword, newUsername, newPassword, privacyLastSeen, privacyProfilePic } = req.body;
    const user = users.find(u => u.username === username && u.password === currentPassword);
    if (!user) return res.status(401).send('Credenciais inválidas');

    if (newUsername && newUsername !== username) {
        if (users.find(u => u.username === newUsername)) return res.status(400).send('Nome já em uso');
        user.username = newUsername;
    }
    if (newPassword) user.password = newPassword;
    if (privacyLastSeen) user.privacyLastSeen = privacyLastSeen;
    if (privacyProfilePic) user.privacyProfilePic = privacyProfilePic;

    res.status(200).json({ status: 'ok', user });
});

app.get('/user/info/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.status(404).send('Not found');

    const canSeePic = user.privacyProfilePic === 'Todos';
    res.json({
        username: user.username,
        profilePic: canSeePic ? user.profilePic : null,
        lastSeen: user.lastSeen,
        privacyLastSeen: user.privacyLastSeen
    });
});

app.post('/user/update_pic', (req, res) => {
    const { username, profilePic } = req.body;
    const user = users.find(u => u.username === username);
    if (user) { user.profilePic = profilePic; res.status(200).json({ status: 'ok' }); }
    else res.status(404).send('Erro');
});

app.get('/status/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.json({ status: 'OFFLINE' });

    const secondsAgo = (Date.now() - user.lastSeen) / 1000;
    if (secondsAgo < 20) return res.json({ status: 'ONLINE' });

    if (user.privacyLastSeen === 'Ninguém') {
        return res.json({ status: 'OFFLINE' });
    }

    const date = new Date(user.lastSeen);
    res.json({ status: `Visto por último ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` });
});

app.post('/send_message', (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    updateSeen(username);
    // Usamos timestamp numérico para o app formatar localmente
    messages.push({
        id: Date.now(),
        from: username,
        to: recipient,
        content,
        isAudio: isAudio || false,
        isImage: isImage || false,
        isVideo: isVideo || false,
        viewOnce: viewOnce || false,
        isGroup: isGroup || false,
        timestamp: Date.now(), // NOVO: Timestamp real
        read: false
    });
    res.status(200).json({ status: 'ok' });
});

app.get('/conversation/:user1/:user2', (req, res) => {
    updateSeen(req.params.user1);
    const chat = messages.filter(m => !m.isGroup && ((m.from === req.params.user1 && m.to === req.params.user2) || (m.from === req.params.user2 && m.to === req.params.user1)));
    res.json(chat);
});

// --- GRUPOS ---
app.post('/create_group', (req, res) => {
    const { name, creator } = req.body;
    const newGroup = { id: 'group_' + Date.now(), name, members: [creator], admins: [creator], profilePic: null };
    groups.push(newGroup);
    res.status(201).json(newGroup);
});

app.get('/groups/:username', (req, res) => {
    res.json(groups.filter(g => g.members.includes(req.params.username)));
});

app.post('/group/update_pic', (req, res) => {
    const { groupId, adminUser, profilePic } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) { group.profilePic = profilePic; res.status(200).json(group); }
    else res.status(403).send('Erro');
});

app.get('/group/messages/:groupId', (req, res) => {
    res.json(messages.filter(m => m.isGroup && m.to === req.params.groupId));
});

// --- RESTO DAS ROTAS MANTIDAS ---
app.post('/delete_message', (req, res) => {
    const index = messages.findIndex(m => m.id === req.body.messageId && m.from === req.body.username);
    if (index !== -1) { messages.splice(index, 1); res.status(200).json({ status: 'ok' }); }
    else res.status(404).send('Erro');
});

app.post('/destroy_view_once', (req, res) => {
    const index = messages.findIndex(m => m.id === req.body.messageId && m.to === req.body.username);
    if (index !== -1) { messages.splice(index, 1); res.status(200).json({ status: 'ok' }); }
    else res.status(404).send('Erro');
});

app.post('/mark_read', (req, res) => {
    updateSeen(req.body.username);
    messages.forEach(m => { if (m.from === req.body.contact && m.to === req.body.username) m.read = true; });
    res.status(200).json({ status: 'ok' });
});

app.post('/clear_messages', (req, res) => {
    const user = users.find(u => u.username === req.body.username && u.password === req.body.password);
    if (user) { messages = messages.filter(m => m.to !== req.body.username); res.status(200).json({ status: 'ok' }); }
    else res.status(401).send('Erro');
});

app.get('/', (req, res) => res.send('NEXUS Midnight Server v12.0 Ativo!'));
app.listen(port, () => console.log(`Servidor NEXUS na porta ${port}`));
