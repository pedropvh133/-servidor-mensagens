const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

let users = []; // [{ username, password, lastSeen, profilePic, privacyLastSeen, privacyProfilePic, privacyCalls, privacyBio, bio }]
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
        privacyProfilePic: 'Todos',
        privacyCalls: 'On',
        bio: 'Olá! Estou usando o Noctis Messenger.'
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
            privacyProfilePic: user.privacyProfilePic,
            privacyCalls: user.privacyCalls || 'On',
            bio: user.bio || 'Olá! Estou usando o Noctis Messenger.'
        });
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

app.post('/user/update_settings', (req, res) => {
    const { username, currentPassword, oldPassword, newUsername, newPassword, privacyLastSeen, privacyProfilePic, privacyCalls, bio } = req.body;
    // Tenta validar tanto com currentPassword quanto com oldPassword por retrocompatibilidade
    const pass = currentPassword || oldPassword;
    const user = users.find(u => u.username === username && u.password === pass);

    if (!user) return res.status(401).json({ error: 'SENHA_ATUAL_INCORRETA' });

    if (newUsername && newUsername !== username) {
        if (users.find(u => u.username === newUsername)) return res.status(400).json({ error: 'NOME_JÁ_EM_USO' });
        messages.forEach(m => { if (m.from === username) m.from = newUsername; if (m.to === username) m.to = newUsername; });
        groups.forEach(g => {
            g.members = g.members.map(m => m === username ? newUsername : m);
            g.admins = g.admins.map(a => a === username ? newUsername : a);
        });
        user.username = newUsername;
    }
    if (newPassword) user.password = newPassword;
    if (privacyLastSeen) user.privacyLastSeen = privacyLastSeen;
    if (privacyProfilePic) user.privacyProfilePic = privacyProfilePic;
    if (privacyCalls) user.privacyCalls = privacyCalls;
    if (bio !== undefined) user.bio = bio;

    res.status(200).json({
        status: 'ok',
        profilePic: user.profilePic,
        privacyLastSeen: user.privacyLastSeen,
        privacyProfilePic: user.privacyProfilePic,
        privacyCalls: user.privacyCalls,
        bio: user.bio
    });
});

app.post('/user/delete_account', (req, res) => {
    const { username, password } = req.body;
    const index = users.findIndex(u => u.username === username && u.password === password);
    if (index !== -1) {
        users.splice(index, 1);
        messages = messages.filter(m => m.from !== username && m.to !== username);
        groups.forEach(g => {
            g.members = g.members.filter(m => m !== username);
            g.admins = g.admins.filter(a => a !== username);
        });
        res.status(200).json({ status: 'ok' });
    } else res.status(401).send('Erro');
});

app.post('/user/update_pic', (req, res) => {
    const { username, profilePic } = req.body;
    const user = users.find(u => u.username === username);
    if (user) {
        user.profilePic = profilePic;
        res.status(200).json({ status: 'ok' });
    } else res.status(404).send('Erro');
});

app.get('/user/info/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.status(404).send('Not found');
    const canSeePic = user.privacyProfilePic === 'Todos';
    res.json({
        username: user.username,
        profilePic: canSeePic ? user.profilePic : null,
        lastSeen: user.lastSeen,
        privacyLastSeen: user.privacyLastSeen,
        bio: user.bio || 'Olá! Estou usando o Noctis Messenger.'
    });
});

app.get('/messages/unread/:username', (req, res) => {
    const username = req.params.username;
    const userGroups = groups.filter(g => g.members.includes(username)).map(g => g.id);
    const unread = messages.filter(m => {
        const isToMe = !m.isGroup && m.to === username && !m.read;
        const isToMyGroup = m.isGroup && userGroups.includes(m.to) && m.from !== username;
        return isToMe || isToMyGroup;
    });
    res.json(unread);
});

app.post('/call/signal', (req, res) => {
    const { to, from, data } = req.body;
    const targetUser = users.find(u => u.username === to);
    if (targetUser && targetUser.privacyCalls === 'Off') return res.status(403).json({ error: 'BLOQUEADO' });
    if (!callSignals[to]) callSignals[to] = [];
    callSignals[to].push({ from, data, time: Date.now() });
    res.status(200).json({ status: 'sent' });
});

app.get('/call/check/:username', (req, res) => {
    const signals = callSignals[req.params.username] || [];
    callSignals[req.params.username] = [];
    res.json(signals);
});

app.get('/status/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.json({ status: 'OFFLINE' });
    if ((Date.now() - user.lastSeen) / 1000 < 20) return res.json({ status: 'ONLINE' });
    if (user.privacyLastSeen === 'Ninguém') return res.json({ status: 'OFFLINE' });
    res.json({ status: `Visto por último ${new Date(user.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` });
});

app.post('/send_message', (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    updateSeen(username);
    messages.push({ id: Date.now(), from: username, to: recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(), read: false });
    res.status(200).json({ status: 'ok' });
});

app.get('/conversation/:user1/:user2', (req, res) => {
    updateSeen(req.params.user1);
    res.json(messages.filter(m => !m.isGroup && ((m.from === req.params.user1 && m.to === req.params.user2) || (m.from === req.params.user2 && m.to === req.params.user1))));
});

app.post('/create_group', (req, res) => {
    const { name, creator } = req.body;
    const newGroup = { id: 'group_' + Date.now(), name, members: [creator], admins: [creator], profilePic: null };
    groups.push(newGroup);
    res.status(201).json(newGroup);
});

app.get('/groups/:username', (req, res) => res.json(groups.filter(g => g.members.includes(req.params.username))));

app.post('/group/update_pic', (req, res) => {
    const { groupId, adminUser, profilePic } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        group.profilePic = profilePic;
        res.status(200).json(group);
    } else res.status(403).send('Erro');
});

app.post('/group/update_name', (req, res) => {
    const { groupId, adminUser, newName } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        group.name = newName;
        res.status(200).json(group);
    } else res.status(403).send('Não autorizado');
});

app.post('/group/delete', (req, res) => {
    const { groupId, adminUser } = req.body;
    const index = groups.findIndex(g => g.id === groupId);
    if (index !== -1 && groups[index].admins.includes(adminUser)) {
        groups.splice(index, 1);
        res.status(200).json({ status: 'ok' });
    } else res.status(403).send('Não autorizado');
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

app.get('/group/messages/:groupId', (req, res) => res.json(messages.filter(m => m.isGroup && m.to === req.params.groupId)));

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

app.get('/', (req, res) => res.send('NOCTIS Blind Server v16.2 Ativo!'));
app.listen(port, () => console.log(`Servidor NOCTIS na porta ${port}`));
