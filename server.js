const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '30mb' }));

let users = [];
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
    users.push({ username, password, lastSeen: Date.now(), profilePic: null });
    res.status(201).json({ status: 'ok' });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'NÃO_ENCONTRADO' });
    if (user.password === password) {
        user.lastSeen = Date.now();
        res.status(200).json({ status: 'ok', profilePic: user.profilePic });
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

// --- POLLING GLOBAL (V11.0) ---
app.get('/messages/unread/:username', (req, res) => {
    const username = req.params.username;
    updateSeen(username);

    // Busca grupos que o usuário participa
    const userGroups = groups.filter(g => g.members.includes(username)).map(g => g.id);

    // Busca mensagens não lidas enviadas PARA o usuário (privado) ou PARA grupos dele
    // Nota: Em grupos, controlamos o 'read' localmente no app por id
    const unread = messages.filter(m =>
        (m.to === username && !m.read && !m.isGroup) ||
        (m.isGroup && userGroups.includes(m.to) && m.from !== username)
    );

    res.json(unread);
});

app.post('/call/signal', (req, res) => {
    const { to, from, data } = req.body;
    if (!callSignals[to]) callSignals[to] = [];
    callSignals[to].push({ from, data, time: Date.now() });
    res.status(200).json({ status: 'sent' });
});

app.get('/call/check/:username', (req, res) => {
    const username = req.params.username;
    const signals = callSignals[username] || [];
    callSignals[username] = [];
    res.json(signals);
});

app.get('/user/info/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.status(404).send('Not found');
    res.json({ username: user.username, profilePic: user.profilePic, lastSeen: user.lastSeen });
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
    if (secondsAgo < 20) res.json({ status: 'ONLINE' });
    else res.json({ status: `Visto por último ${new Date(user.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` });
});

app.post('/send_message', (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    updateSeen(username);
    messages.push({ id: Date.now(), from: username, to: recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), read: false });
    res.status(200).json({ status: 'ok' });
});

app.get('/conversation/:user1/:user2', (req, res) => {
    updateSeen(req.params.user1);
    const chat = messages.filter(m => !m.isGroup && ((m.from === req.params.user1 && m.to === req.params.user2) || (m.from === req.params.user2 && m.to === req.params.user1)));
    res.json(chat);
});

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

app.post('/group/add_member', (req, res) => {
    const { groupId, adminUser, newMember } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) { if (!group.members.includes(newMember)) group.members.push(newMember); res.status(200).json(group); }
    else res.status(403).send('Erro');
});

app.post('/group/remove_member', (req, res) => {
    const { groupId, adminUser, targetUser } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) { group.members = group.members.filter(m => m !== targetUser); group.admins = group.admins.filter(a => a !== targetUser); res.status(200).json(group); }
    else res.status(403).send('Erro');
});

app.post('/group/promote', (req, res) => {
    const { groupId, adminUser, targetUser } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) { if (!group.admins.includes(targetUser)) group.admins.push(targetUser); res.status(200).json(group); }
    else res.status(403).send('Erro');
});

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

app.get('/', (req, res) => res.send('NEXUS Blind Server v11.0 Ativo!'));
app.listen(port, () => console.log(`Servidor NEXUS na porta ${port}`));
