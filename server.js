const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '30mb' }));

let users = []; // [{ username, password, lastSeen, profilePic }]
let messages = [];
let groups = []; // [{ id, name, members: [], admins: [], profilePic }]

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

app.get('/user/info/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.status(404).send('Not found');
    res.json({
        username: user.username,
        profilePic: user.profilePic,
        lastSeen: user.lastSeen
    });
});

app.post('/user/update_pic', (req, res) => {
    const { username, profilePic } = req.body;
    const user = users.find(u => u.username === username);
    if (user) {
        user.profilePic = profilePic;
        res.status(200).json({ status: 'ok' });
    } else res.status(404).send('Erro');
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
    const msg = {
        id: Date.now(),
        from: username,
        to: recipient,
        content,
        isAudio: isAudio || false,
        isImage: isImage || false,
        isVideo: isVideo || false,
        viewOnce: viewOnce || false,
        isGroup: isGroup || false,
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
        !m.isGroup && (
            (m.from === user1 && m.to === user2) ||
            (m.from === user2 && m.to === user1)
        )
    );
    res.json(chat);
});

// --- GRUPOS ---
app.post('/create_group', (req, res) => {
    const { name, creator } = req.body;
    const groupId = 'group_' + Date.now();
    const newGroup = { id: groupId, name: name, members: [creator], admins: [creator], profilePic: null };
    groups.push(newGroup);
    res.status(201).json(newGroup);
});

app.get('/groups/:username', (req, res) => {
    const userGroups = groups.filter(g => g.members.includes(req.params.username));
    res.json(userGroups);
});

app.post('/group/update_pic', (req, res) => {
    const { groupId, adminUser, profilePic } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        group.profilePic = profilePic;
        res.status(200).json(group);
    } else res.status(403).send('Erro');
});

app.get('/group/messages/:groupId', (req, res) => {
    const groupMsgs = messages.filter(m => m.isGroup && m.to === req.params.groupId);
    res.json(groupMsgs);
});

app.post('/group/add_member', (req, res) => {
    const { groupId, adminUser, newMember } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (!group.members.includes(newMember)) group.members.push(newMember);
        res.status(200).json(group);
    } else res.status(403).send('Erro');
});

app.post('/group/remove_member', (req, res) => {
    const { groupId, adminUser, targetUser } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        group.members = group.members.filter(m => m !== targetUser);
        group.admins = group.admins.filter(a => a !== targetUser);
        res.status(200).json(group);
    } else res.status(403).send('Erro');
});

app.post('/group/promote', (req, res) => {
    const { groupId, adminUser, targetUser } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (!group.admins.includes(targetUser)) group.admins.push(targetUser);
        res.status(200).json(group);
    } else res.status(403).send('Erro');
});

app.post('/delete_message', (req, res) => {
    const { messageId, username } = req.body;
    const index = messages.findIndex(m => m.id === messageId && m.from === username);
    if (index !== -1) { messages.splice(index, 1); res.status(200).json({ status: 'ok' }); }
    else res.status(404).send('Erro');
});

app.post('/destroy_view_once', (req, res) => {
    const { messageId, username } = req.body;
    const index = messages.findIndex(m => m.id === messageId && m.to === username);
    if (index !== -1) { messages.splice(index, 1); res.status(200).json({ status: 'ok' }); }
    else res.status(404).send('Erro');
});

app.post('/mark_read', (req, res) => {
    const { username, contact } = req.body;
    updateSeen(username);
    messages.forEach(m => { if (m.from === contact && m.to === username) m.read = true; });
    res.status(200).json({ status: 'ok' });
});

app.post('/clear_messages', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (user) { messages = messages.filter(m => m.to !== username); res.status(200).json({ status: 'ok' }); }
    else res.status(401).send('Erro');
});

app.get('/', (req, res) => res.send('CyberServer v9.0 (Fotos de Perfil) Ativo!'));
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
