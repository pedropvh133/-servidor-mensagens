/**
 * NOCTIS MESSENGER - SERVER MASTER V22.6 (RESCUE + STABLE)
 * ESTABILIZAÇÃO TOTAL + TRATAMENTO DE CRASH 🛡️
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');
const multer = require('multer');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true,
    maxHttpBufferSize: 1e8 
});
const port = process.env.PORT || 3000;

// --- ESTADO GLOBAL ---
let users = [];
let messages = [];
let groups = [];
let callSignals = {};
let userSockets = {};
let firebaseStatus = "Aguardando... ⚪";
let b2Status = "Aguardando... ⚪";
let cachedBucketName = null;
let b2ConnCache = { authToken: null, uploadUrl: null, uploadAuthToken: null, expiry: 0 };
let adminPassword = "pedropvh133@gmail.com/admin";
let latestVersionCode = 1;
let latestApkName = "";

// --- FIREBASE RESILIENTE ---
try {
    const rawConfig = process.env.FIREBASE_CONFIG;
    if (rawConfig) {
        const sanitized = rawConfig.trim().replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
        const serviceAccount = JSON.parse(sanitized);
        if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        firebaseStatus = "ONLINE 🔥";
    }
} catch (err) { firebaseStatus = "ERRO CONFIG 🔥"; console.error("Firebase Init Error:", err.message); }

const db = (admin.apps.length > 0) ? admin.firestore() : null;

// --- B2 RESILIENTE ---
const b2 = new B2({ applicationKeyId: process.env.B2_KEY_ID || '', applicationKey: process.env.B2_APP_KEY || '' });
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

async function initB2() {
    if (!process.env.B2_KEY_ID || !B2_BUCKET_ID) return;
    try {
        await b2.authorize();
        const bucketResp = await b2.getBucket({ bucketId: B2_BUCKET_ID });
        if (bucketResp.data.buckets && bucketResp.data.buckets.length > 0) {
            cachedBucketName = bucketResp.data.buckets[0].bucketName;
            b2Status = "CONECTADO ☁️";
        }
    } catch (e) { b2Status = "OFFLINE ❌"; console.error("B2 Init Error:", e.message); }
}
initB2();

// --- CARGA DE DADOS ---
async function loadDataFromBackup() {
    if (!db) return;
    try {
        const userSnap = await db.collection('users').get();
        users = userSnap.docs.map(d => {
            const data = d.data();
            if (!data.blockedUsers) data.blockedUsers = []; // Garante que a lista existe 🛡️
            return data;
        });
        const groupSnap = await db.collection('groups').get();
        groups = groupSnap.docs.map(d => d.data());
        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(2000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();
        const configDoc = await db.collection('system').doc('config').get();
        if (configDoc.exists) {
            latestVersionCode = configDoc.data().versionCode || 1;
            latestApkName = configDoc.data().apkName || "";
            if (configDoc.data().adminPassword) adminPassword = configDoc.data().adminPassword;
        }
    } catch (e) { console.error("Backup Error:", e.message); }
}
loadDataFromBackup();

// --- FUNÇÕES DE APOIO ---
function getFileSHA1(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
}

async function getB2UploadParams() {
    const now = Date.now();
    if (b2ConnCache.authToken && b2ConnCache.uploadUrl && now < b2ConnCache.expiry) {
        return { uploadUrl: b2ConnCache.uploadUrl, uploadAuthToken: b2ConnCache.uploadAuthToken };
    }
    await b2.authorize();
    const resp = await b2.getUploadUrl({ bucketId: B2_BUCKET_ID });
    b2ConnCache = { authToken: b2.authorizationToken, uploadUrl: resp.data.uploadUrl, uploadAuthToken: resp.data.authorizationToken, expiry: now + (2 * 60 * 60 * 1000) };
    return { uploadUrl: b2ConnCache.uploadUrl, uploadAuthToken: b2ConnCache.uploadAuthToken };
}

async function uploadToB2(dataOrPath, fileName, isFilePath = false, retry = true) {
    if (!B2_BUCKET_ID) return { error: "B2_BUCKET_ID ausente." };
    try {
        const { uploadUrl, uploadAuthToken } = await getB2UploadParams();
        let params = { uploadUrl, uploadAuthToken, fileName };
        if (isFilePath) {
            params.contentLength = fs.statSync(dataOrPath).size;
            params.contentSha1 = await getFileSHA1(dataOrPath);
            params.data = fs.createReadStream(dataOrPath);
        } else { params.data = dataOrPath; }
        const resp = await b2.uploadFile(params);
        return { url: `B2_URL:${resp.data.fileName}` };
    } catch (e) {
        if (retry) { b2ConnCache.expiry = 0; return uploadToB2(dataOrPath, fileName, isFilePath, false); }
        return { error: e.message };
    }
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

// --- ROTAS ADMIN ---
app.post('/admin/upload_apk', multer({ dest: '/tmp/' }).single('a'), async (req, res) => {
    const { v, p } = req.body;
    if (p !== adminPassword) return res.status(403).send('Negado');
    if (!req.file) return res.status(400).send('Sem arquivo');
    try {
        const fileName = `n_v${v}_${Date.now()}.apk`;
        const result = await uploadToB2(req.file.path, fileName, true);
        if (result.url) {
            latestVersionCode = parseInt(v); latestApkName = fileName;
            if (db) await db.collection('system').doc('config').set({ versionCode: latestVersionCode, apkName: latestApkName, adminPassword }, { merge: true });
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.json({ status: 'ok' });
        } else res.status(500).send(result.error);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/admin/update_version', async (req, res) => {
    const { versionCode, password } = req.body;
    if (password !== adminPassword) return res.status(403).send('Negado');
    latestVersionCode = parseInt(versionCode);
    if (db) await db.collection('system').doc('config').update({ versionCode: latestVersionCode });
    res.json({ status: 'ok' });
});

app.post('/admin/change_password', async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (oldPassword !== adminPassword) return res.status(403).send('Negado');
    adminPassword = newPassword;
    if (db) await db.collection('system').doc('config').update({ adminPassword });
    res.json({ status: 'ok' });
});

// --- ROTAS USUÁRIO ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).send('Existe');
    const u = { username, password, bio: 'Olá!', profilePic: null, lastSeen: Date.now(), blockedUsers: [] };
    users.push(u); res.status(201).json({ status: 'ok' });
    if (db) await db.collection('users').doc(username).set(u);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const u = users.find(x => x.username === username);
    if (u && u.password === password) {
        u.lastSeen = Date.now(); res.json({ status: 'ok', ...u });
        if (db) await db.collection('users').doc(username).update({ lastSeen: Date.now() });
    } else res.status(401).send('Erro');
});

app.post('/user/update_pic', async (req, res) => {
    const { username, profilePic } = req.body;
    const r = await uploadToB2(Buffer.from(profilePic, 'base64'), `p_${Date.now()}`);
    if (r.url) {
        const u = users.find(x => x.username === username);
        if (u) { u.profilePic = r.url; if (db) await db.collection('users').doc(username).update({ profilePic: r.url }); }
        res.json({ status: 'ok', profilePic: r.url });
    } else res.status(500).send(r.error);
});

app.get('/user/info/:username', (req, res) => {
    const u = users.find(x => x.username === req.params.username);
    if (u) { const { password, ...safe } = u; res.json(safe); } else res.status(404).send('Off');
});

app.get('/conversations/list/:username', (req, res) => {
    const me = req.params.username; const set = new Set();
    messages.forEach(m => { if (!m.isGroup) { if (m.from === me) set.add(m.to); if (m.to === me) set.add(m.from); } });
    res.json(users.filter(u => set.has(u.username)).map(u => { const { password, ...s } = u; return s; }));
});

app.get('/status/:username', (req, res) => {
    const u = users.find(x => x.username === req.params.username);
    res.json({ status: (u && (Date.now() - u.lastSeen) < 60000) ? "Online" : "Visto recentemente" });
});

app.post('/user/update_settings', async (req, res) => {
    const { username, currentPassword, newUsername, newPassword, bio } = req.body;
    const u = users.find(x => x.username === username && x.password === currentPassword);
    if (u) { 
        if (newUsername) u.username = newUsername; if (newPassword) u.password = newPassword; if (bio) u.bio = bio;
        res.json({ status: 'ok', ...u }); if (db) await db.collection('users').doc(username).set(u);
    } else res.status(401).send('Erro');
});

app.post('/user/block', async (req, res) => {
    const { username, target } = req.body;
    const u = users.find(x => x.username === username);
    if (u) { 
        if (!u.blockedUsers) u.blockedUsers = [];
        if (!u.blockedUsers.includes(target)) u.blockedUsers.push(target); 
        res.json({ status: 'ok' }); if (db) await db.collection('users').doc(username).update({ blockedUsers: u.blockedUsers }); 
    } else res.status(404).send('Erro');
});

app.post('/user/unblock', async (req, res) => {
    const { username, target } = req.body;
    const u = users.find(x => x.username === username);
    if (u && u.blockedUsers) { u.blockedUsers = u.blockedUsers.filter(b => b !== target); res.json({ status: 'ok' }); if (db) await db.collection('users').doc(username).update({ blockedUsers: u.blockedUsers }); }
    else res.status(404).send('Erro');
});

app.get('/user/blocked_list/:username', (req, res) => res.json(users.find(u => u.username === req.params.username)?.blockedUsers || []));

// --- GRUPOS ---
app.post('/create_group', async (req, res) => {
    const { name, creator, description, rules } = req.body;
    const id = 'group_' + Date.now();
    const g = { id, name, creator, members: [creator], admins: [creator], profilePic: null, description: description || "", rules: rules || "" };
    groups.push(g); res.status(201).json(g);
    if (db) await db.collection('groups').doc(id).set(g);
});

app.get('/groups/:username', (req, res) => res.json(groups.filter(g => g.members.includes(req.params.username))));

app.post(['/group/update_name', '/group/update_settings'], async (req, res) => {
    const { groupId, adminUser, name, description, rules } = req.body;
    const g = groups.find(x => x.id === groupId && x.admins.includes(adminUser));
    if (g) {
        if (name) g.name = name; if (description !== undefined) g.description = description; if (rules !== undefined) g.rules = rules;
        res.json(g); if (db) await db.collection('groups').doc(groupId).update({ name: g.name, description: g.description, rules: g.rules });
    } else res.status(403).send('Erro');
});

app.post('/group/leave', async (req, res) => {
    const { groupId, adminUser } = req.body;
    const g = groups.find(x => x.id === groupId && x.members.includes(adminUser));
    if (g) {
        g.members = g.members.filter(m => m !== adminUser); g.admins = g.admins.filter(a => a !== adminUser);
        if (g.members.length === 0) { groups = groups.filter(x => x.id !== groupId); if (db) await db.collection('groups').doc(groupId).delete(); return res.json({ status: 'ok', deleted: true }); }
        if (g.admins.length === 0 && g.members.length > 0) g.admins.push(g.members[0]);
        if (db) await db.collection('groups').doc(groupId).update({ members: g.members, admins: g.admins });
        res.json({ status: 'ok' });
    } else res.status(404).send('Off');
});

// --- MENSAGENS ---
app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup, unlockTimestamp, replyToId, replyText, replySender } = req.body;
    const target = isGroup ? groups.find(g => g.id === recipient) : users.find(u => u.username === recipient);
    if (!isGroup && target?.blockedUsers?.includes(username)) return res.json({ status: 'ok' });

    let final = content;
    if (isAudio || isImage || isVideo) {
        const r = await uploadToB2(Buffer.from(content, 'base64'), `m_${Date.now()}`);
        if (r.url) final = r.url; else return res.status(500).send(r.error);
    }

    const m = { id: Date.now(), from: username, to: recipient, content: final, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(), read: false, delivered: false, unlockTimestamp, replyToId, replyText, replySender, reactions: {} };
    messages.push(m); res.json({ status: 'ok' });

    if (isGroup) {
        const g = groups.find(x => x.id === recipient);
        g?.members.forEach(mm => { if (mm !== username && userSockets[mm]) userSockets[mm].forEach(s => io.to(s).emit('new_message', { ...m, groupName: g.name })); });
    } else {
        userSockets[recipient]?.forEach(s => io.to(s).emit('new_message', m));
    }
    if (db) await db.collection('messages').doc(m.id.toString()).set(m);
});

app.get('/conversation/:u1/:u2', async (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));
    for (let m of list) { if (m.from === req.params.u2 && !m.delivered) { m.delivered = true; if (db) await db.collection('messages').doc(m.id.toString()).update({ delivered: true }); } }
    res.json(list);
});

app.get('/messages/unread/:username', (req, res) => {
    const me = req.params.username;
    const resList = messages.filter(m => ((!m.isGroup && m.to === me) || (m.isGroup && groups.find(g => g.id === m.to && g.members.includes(me)) && m.from !== me)) && !m.read);
    res.json(resList);
});

app.post('/mark_read', async (req, res) => {
    const { username, contact } = req.body;
    messages.forEach(m => { if (!m.isGroup && m.from === contact && m.to === username && !m.read) { m.read = true; if (db) await db.collection('messages').doc(m.id.toString()).update({ read: true }); } });
    res.json({ status: 'ok' });
});

app.post('/call/signal', (req, res) => {
    const { to, from, data } = req.body;
    const sig = { from, data, time: Date.now() };
    if (to.startsWith('group_')) {
        groups.find(x => x.id === to)?.members.forEach(mm => { if (mm !== from && userSockets[mm]) userSockets[mm].forEach(s => io.to(s).emit('call_signal', sig)); });
    } else { userSockets[to]?.forEach(s => io.to(s).emit('call_signal', sig)); }
    res.json({ status: 'ok' });
});

app.get('/call/check/:username', (req, res) => {
    res.setHeader('X-Latest-Version', latestVersionCode.toString());
    res.setHeader('X-Apk-Name', latestApkName || "");
    res.json([]);
});

// --- PAINEL MASTER ---
app.get('/admin', (req, res) => {
    const total = users.length;
    const online = users.filter(u => (Date.now() - (u.lastSeen || 0)) < 60000).length;
    res.send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>NOCTIS MASTER</title>
        <
