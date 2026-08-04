/**
 * NOCTIS MESSENGER - SERVER MASTER V22.9 (BULLETPROOF)
 * FOCO: ESTABILIDADE NO RENDER + RESOLVER FOTOS 🛰️
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true
});
const port = process.env.PORT || 3000;

// --- ESTADO GLOBAL ---
let users = [];
let messages = [];
let groups = [];
let callSignals = {}; // ARMAZENAMENTO DE SINAIS DE CHAMADA 📞 ✅
let userSockets = {};
let latestVersionCode = 1;
let latestApkName = "";
let adminPassword = "pedropvh133@gmail.com/admin";
let cachedBucketName = null; // Para resolver as fotos 🖼️

// --- FIREBASE ---
try {
    const rawConfig = process.env.FIREBASE_CONFIG;
    if (rawConfig) {
        const config = JSON.parse(rawConfig.trim().replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
        if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(config) });
    }
} catch (e) { console.error("Firebase Init Skip:", e.message); }

const db = (admin.apps.length > 0) ? admin.firestore() : null;

// --- B2 STORAGE ---
const b2 = new B2({
    applicationKeyId: process.env.B2_KEY_ID || '',
    applicationKey: process.env.B2_APP_KEY || ''
});

// --- SYNC INICIAL ---
async function syncData() {
    if (!db) return;
    try {
        const uSnap = await db.collection('users').get();
        users = uSnap.docs.map(d => ({ blockedUsers: [], ...d.data() }));
        const gSnap = await db.collection('groups').get();
        groups = gSnap.docs.map(d => d.data());
        const mSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(300).get();
        messages = mSnap.docs.map(d => d.data()).reverse();
        const cfg = await db.collection('system').doc('config').get();
        if (cfg.exists) {
            latestVersionCode = cfg.data().versionCode || 1;
            latestApkName = cfg.data().apkName || "";
            if (cfg.data().adminPassword) adminPassword = cfg.data().adminPassword;
        }
    } catch (e) { console.error("Sync Error:", e.message); }
}
syncData();

// --- HELPERS ---
async function authorizeB2() {
    await b2.authorize();
    if (!cachedBucketName) {
        const bucketsResp = await b2.getBucket({ bucketId: process.env.B2_BUCKET_ID });
        if (bucketsResp.data.buckets && bucketsResp.data.buckets.length > 0) {
            cachedBucketName = bucketsResp.data.buckets[0].bucketName;
        }
    }
}

async function uploadToB2(data, name, isPath = false) {
    try {
        await authorizeB2();
        const resp = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });
        const upParams = {
            uploadUrl: resp.data.uploadUrl,
            uploadAuthToken: resp.data.authorizationToken,
            fileName: name
        };
        if (isPath) {
            upParams.data = fs.createReadStream(data);
            upParams.contentLength = fs.statSync(data).size;
        } else {
            upParams.data = data;
        }
        const r = await b2.uploadFile(upParams);
        return { url: `B2_URL:${r.data.fileName}` };
    } catch (e) { return { error: e.message }; }
}

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// --- ROTAS ADMIN ---
app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>MASTER</title><style>body{background:#05070A;color:#00D2FF;font-family:sans-serif;display:flex;justify-content:center;padding:50px;} .card{background:#0A0F1E;padding:40px;border-radius:20px;border:1px solid #00D2FF;width:100%;max-width:400px;} input{width:100%;margin-bottom:15px;padding:15px;background:#000;border:1px solid #00D2FF;color:#FFF;} .btn{width:100%;padding:15px;background:#00D2FF;color:#000;font-weight:bold;cursor:pointer;}</style></head>
    <body><div class="card"><h1>🛰️ MASTER</h1><p>Usuários: ${users.length}</p><form id="f"><input name="v" type="number" value="${latestVersionCode+1}"><input name="a" type="file"><input name="p" type="password" placeholder="KEY"><button type="submit" class="btn">DEPLOY APK</button></form><p id="m"></p></div>
    <script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const fd=new FormData(e.target);const m=document.getElementById('m');m.innerText="Uplink...";if(fd.get('a').size>0){const xhr=new XMLHttpRequest();xhr.open('POST','/admin/upload_apk',true);xhr.onload=()=>{if(xhr.status===200){alert('SUCESSO!');location.reload();}else{m.innerText="ERRO: "+xhr.responseText;}};xhr.send(fd);}else{const r=await fetch('/admin/update_version',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({versionCode:fd.get('v'),password:fd.get('p')})});m.innerText=r.ok?"Versão OK":"Erro";}};</script></body></html>`);
});

app.post('/admin/upload_apk', multer({ dest: '/tmp/' }).single('a'), async (req, res) => {
    const { v, p } = req.body;
    if (p !== adminPassword) return res.status(403).send('Negado');
    if (!req.file) return res.status(400).send('Sem arquivo');
    const result = await uploadToB2(req.file.path, `update_v${v}_${Date.now()}.apk`, true);
    if (result.url) {
        latestVersionCode = parseInt(v); latestApkName = result.url.split(':')[1];
        if (db) await db.collection('system').doc('config').set({ versionCode: latestVersionCode, apkName: latestApkName, adminPassword }, { merge: true });
        fs.unlinkSync(req.file.path);
        res.send('ok');
    } else res.status(500).send(result.error);
});

app.post('/admin/update_version', async (req, res) => {
    if (req.body.password !== adminPassword) return res.status(403).send('Erro');
    latestVersionCode = parseInt(req.body.versionCode);
    if (db) await db.collection('system').doc('config').update({ versionCode: latestVersionCode });
    res.send('ok');
});

// --- ROTAS APP ---
app.post('/login', (req, res) => {
    const u = users.find(x => x.username === req.body.username && x.password === req.body.password);
    if (u) { u.lastSeen = Date.now(); res.json({ status: 'ok', ...u }); }
    else res.status(401).send('Off');
});

app.post('/register', async (req, res) => {
    if (users.find(x => x.username === req.body.username)) return res.status(400).send('Existe');
    const u = { username: req.body.username, password: req.body.password, bio: 'Olá!', profilePic: null, lastSeen: Date.now(), blockedUsers: [] };
    users.push(u); if (db) await db.collection('users').doc(u.username).set(u);
    res.status(201).json({ status: 'ok' });
});

app.post('/send_message', async (req, res) => {
    const d = req.body; let content = d.content;
    if (d.isAudio || d.isImage || d.isVideo) {
        const r = await uploadToB2(Buffer.from(d.content, 'base64'), `media_${Date.now()}`);
        if (r.url) content = r.url; else return res.status(500).send(r.error);
    }
    const m = { id: Date.now(), from: d.username, to: d.recipient, content, isAudio: d.isAudio||false, isImage: d.isImage||false, isVideo: d.isVideo||false, viewOnce: d.viewOnce||false, isGroup: d.isGroup||false, timestamp: Date.now(), read: false, delivered: false, reactions: {} };
    messages.push(m); res.json({ status: 'ok' });
    if (d.isGroup) {
        const g = groups.find(x => x.id === d.recipient);
        g?.members.forEach(u => { if (u !== d.username) userSockets[u]?.forEach(s => io.to(s).emit('new_message', { ...m, groupName: g.name })); });
    } else { userSockets[d.recipient]?.forEach(s => io.to(s).emit('new_message', m)); }
    if (db) await db.collection('messages').doc(m.id.toString()).set(m);
});

app.get('/conversation/:u1/:u2', async (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));

    // MARCA COMO ENTREGUE: Quando o usuário abre a conversa 🛰️ ✅
    let changed = false;
    for (let m of messages) {
        if (!m.isGroup && m.from === req.params.u2 && m.to === req.params.u1 && !m.delivered) {
            m.delivered = true;
            changed = true;
            if (db) db.collection('messages').doc(m.id.toString()).update({ delivered: true });
        }
    }
    res.json(list);
});

app.get('/messages/unread/:u', (req, res) => {
    const me = req.params.u;
    const resList = messages.filter(m => !m.read && ((!m.isGroup && m.to === me) || (m.isGroup && groups.find(g => g.id === m.to && g.members.includes(me)) && m.from !== me)));

    // MARCA COMO ENTREGUE: Assim que o serviço de fundo do amigo "ver" a mensagem 🛰️ ✅
    resList.forEach(m => {
        if (!m.delivered) {
            m.delivered = true;
            if (db) db.collection('messages').doc(m.id.toString()).update({ delivered: true });
        }
    });
    res.json(resList);
});

app.get('/groups/:u', (req, res) => res.json(groups.filter(g => g.members.includes(req.params.u))));
app.get('/user/info/:u', (req, res) => res.json(users.find(u => u.username === req.params.u) || {}));
app.get('/status/:u', (req, res) => {
    const u = users.find(x => x.username === req.params.u);
    res.json({ status: (u && (Date.now() - u.lastSeen) < 60000) ? "Online" : "Visto recentemente" });
});

app.get('/conversations/list/:u', (req, res) => {
    const me = req.params.u; const set = new Set();
    messages.forEach(m => { if(!m.isGroup){ if(m.from===me) set.add(m.to); if(m.to===me) set.add(m.from); }});
    res.json(users.filter(u => set.has(u.username)).map(u => { const {password, ...s} = u; return s; }));
});

app.post('/call/signal', (req, res) => {
    const { to, from, data } = req.body;
    const signalData = { from, data, time: Date.now() };

    // LÓGICA DE BROADCAST PARA GRUPOS 🛰️ ✅
    if (to.startsWith('group_')) {
        const group = groups.find(g => g.id === to);
        if (group) {
            group.members.forEach(member => {
                if (member !== from) {
                    const gSignal = { ...signalData, groupName: group.name, groupId: group.id };
                    if (!callSignals[member]) callSignals[member] = [];
                    callSignals[member].push(gSignal);
                    userSockets[member]?.forEach(sid => io.to(sid).emit('call_signal', gSignal));
                }
            });
            return res.json({ status: 'ok' });
        }
    }

    // SINAL 1 PRA 1
    if (!callSignals[to]) callSignals[to] = [];
    callSignals[to].push(signalData);
    userSockets[to]?.forEach(sid => io.to(sid).emit('call_signal', signalData));
    res.json({ status: 'ok' });
});

app.get('/call/check/:username', (req, res) => {
    const u = req.params.username;
    const signals = callSignals[u] || [];
    callSignals[u] = []; // Limpa após o celular ler 🧹 ✅
    res.setHeader('X-Latest-Version', latestVersionCode.toString());
    res.setHeader('X-Apk-Name', latestApkName || "");
    res.json(signals);
});

app.get('/b2file/:f', async (req, res) => {
    try {
        await authorizeB2();
        const r = await b2.downloadFileByName({ bucketName: cachedBucketName, fileName: req.params.f, responseType: 'arraybuffer' });
        res.send(Buffer.from(r.data));
    } catch (e) { res.status(404).send('Off'); }
});

app.get('/', (req, res) => res.send('NOCTIS ONLINE ✅'));

// --- SOCKET ---
io.on('connection', (s) => {
    let u = null;
    s.on('auth', (id) => { u = id; if (!userSockets[u]) userSockets[u] = []; userSockets[u].push(s.id); io.emit('user_online', u); });
    s.on('disconnect', () => { if (u && userSockets[u]) { userSockets[u] = userSockets[u].filter(x => x !== s.id); if (userSockets[u].length === 0) delete userSockets[u]; } });
});

server.listen(port, () => console.log('Live.'));
