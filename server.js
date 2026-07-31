/**
 * NOCTIS MESSENGER - SERVER V20.45 (VAULT STABILIZATION)
 * ESTABILIZAÇÃO TOTAL: Sincronia de Fotos, Envio Blindado e Anti-Timeout.
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const upload = multer({ dest: '/tmp/' });

const app = express();
const port = process.env.PORT || 3000;

// --- ESTADO GLOBAL (RAM) ---
let users = [];
let messages = [];
let groups = [];
let callSignals = {};
let firebaseStatus = "Aguardando... ⚪";
let b2Status = "Aguardando... ⚪";
let cachedBucketName = null;

// --- CONTROLE DE VERSÃO ---
let latestVersionCode = 1;
let latestApkName = "";

// --- FIREBASE CONFIG (LIMPEZA SEGURA) ---
const rawConfig = process.env.FIREBASE_CONFIG;
if (rawConfig) {
    try {
        let sanitized = rawConfig.trim()
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

        if (sanitized.startsWith('"') && sanitized.endsWith('"')) {
            sanitized = sanitized.substring(1, sanitized.length - 1);
        }

        const serviceAccount = JSON.parse(sanitized);
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        firebaseStatus = "Conectado! 🔥";
    } catch (err) {
        try {
            const forced = rawConfig.replace(/\n/g, "\\n");
            const serviceAccount = JSON.parse(forced);
            if (admin.apps.length === 0) {
                admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            }
            firebaseStatus = "Conectado! 🔥";
        } catch (err2) {
            firebaseStatus = `Erro Config: ${err.message} ❌`;
        }
    }
}
const db = (admin.apps.length > 0) ? admin.firestore() : null;

// --- BACKBLAZE B2 ---
const b2 = new B2({ applicationKeyId: process.env.B2_KEY_ID || '', applicationKey: process.env.B2_APP_KEY || '' });
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

async function initB2() {
    if (!process.env.B2_KEY_ID || !B2_BUCKET_ID) return;
    try {
        await b2.authorize();
        const bucketResp = await b2.getBucket({ bucketId: B2_BUCKET_ID });
        if (bucketResp.data.buckets && bucketResp.data.buckets.length > 0) {
            cachedBucketName = bucketResp.data.buckets[0].bucketName;
            b2Status = "Autorizado! ☁️";
        }
    } catch (e) { b2Status = "Erro B2 ❌"; }
}
initB2();

// --- RESSURREIÇÃO ---
async function loadDataFromBackup() {
    if (!db) return;
    try {
        const userSnap = await db.collection('users').get();
        users = userSnap.docs.map(d => d.data());
        const groupSnap = await db.collection('groups').get();
        groups = groupSnap.docs.map(d => d.data());
        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(2000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();

        const configDoc = await db.collection('system').doc('config').get();
        if (configDoc.exists) {
            latestVersionCode = configDoc.data().versionCode || 1;
            latestApkName = configDoc.data().apkName || "";
        }
    } catch (e) { console.error('Erro Backup'); }
}
loadDataFromBackup();

// --- BROADCAST DE MUDANÇA NO GRUPO ---
function notifyGroupChange(groupId, adminSender) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    group.members.forEach(member => {
        if (!callSignals[member]) callSignals[member] = [];
        callSignals[member].push({
            from: adminSender,
            data: Buffer.from(`GROUP_STATE_CHANGED:${groupId}`).toString('base64'),
            time: Date.now()
        });
    });
}

// --- MIDIA ---
let b2AuthCache = null;
let b2AuthTime = 0;

async function uploadToB2(bufferData, fileName) {
    if (!B2_BUCKET_ID) return null;
    try {
        if (!b2AuthCache || (Date.now() - b2AuthTime > 12 * 60 * 60 * 1000)) {
            await b2.authorize();
            b2AuthCache = true;
            b2AuthTime = Date.now();
        }
        const uploadUrlResp = await b2.getUploadUrl({ bucketId: B2_BUCKET_ID });
        const uploadResp = await b2.uploadFile({
            uploadUrl: uploadUrlResp.data.uploadUrl,
            uploadAuthToken: uploadUrlResp.data.authorizationToken,
            fileName: fileName,
            data: bufferData
        });
        return `B2_URL:${uploadResp.data.fileName}`;
    } catch (e) {
        console.error("Erro B2:", e.message);
        b2AuthCache = null;
        return null;
    }
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

// --- ADMIN ---

app.post('/admin/upload_apk', upload.single('apkFile'), async (req, res) => {
    const { versionCode, password } = req.body;
    if (password !== "pedropvh133@gmail.com/admin") return res.status(403).send('Senha Incorreta');
    if (!req.file) return res.status(400).send('Arquivo não enviado');
    try {
        const fileName = `update_v${versionCode}_${Date.now()}.apk`;
        const fileBuffer = fs.readFileSync(req.file.path);
        const b2Url = await uploadToB2(fileBuffer, fileName);
        if (b2Url) {
            latestVersionCode = parseInt(versionCode);
            latestApkName = fileName;
            if (db) db.collection('system').doc('config').set({ versionCode: latestVersionCode, apkName: latestApkName });
            fs.unlinkSync(req.file.path);
            res.json({ status: 'ok', versionCode: latestVersionCode, apkName: latestApkName });
        } else res.status(500).send('Erro no B2 Cloud');
    } catch (e) { res.status(500).send('Erro interno: ' + e.message); }
});

app.post('/admin/update_version', async (req, res) => {
    const { versionCode, apkName, password } = req.body;
    if (password !== "pedropvh133@gmail.com/admin") return res.status(403).send('Negado');
    latestVersionCode = parseInt(versionCode);
    latestApkName = apkName;
    res.json({ status: 'ok', versionCode: latestVersionCode, apkName: latestApkName });
    if (db) db.collection('system').doc('config').set({ versionCode: latestVersionCode, apkName: latestApkName }).catch(() => {});
});

// --- USUÁRIO ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });
    const newUser = { username, password, bio: 'Olá!', profilePic: null, lastSeen: Date.now(), blockedUsers: [] };
    users.push(newUser);
    res.status(201).json({ status: 'ok' });
    if (db) db.collection('users').doc(username).set(newUser).catch(() => {});
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'NÃO_ENCONTRADO' });
    if (user.password === password) {
        user.lastSeen = Date.now();
        res.status(200).json({ status: 'ok', ...user });
        if (db) db.collection('users').doc(username).update({ lastSeen: Date.now() }).catch(() => {});
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

app.post('/user/update_pic', async (req, res) => {
    const { username, profilePic } = req.body;
    const b2Url = await uploadToB2(Buffer.from(profilePic, 'base64'), `profile_${username}_${Date.now()}`);
    if (b2Url) {
        let user = users.find(u => u.username === username);
        if (user) {
            user.profilePic = b2Url;
            res.status(200).json({ status: 'ok' });
            if (db) db.collection('users').doc(username).update({ profilePic: b2Url }).catch(() => {});
        } else res.status(404).send('Not found');
    } else res.status(500).send('B2 Error');
});

// --- GRUPOS ---

app.post('/create_group', async (req, res) => {
    const { name, creator, description, rules } = req.body;
    const groupId = 'group_' + Date.now();
    const newGroup = { id: groupId, name, creator, members: [creator], admins: [creator], profilePic: null, description: description || "", rules: rules || "" };
    groups.push(newGroup);
    res.status(201).json(newGroup);
    if (db) db.collection('groups').doc(groupId).set(newGroup).catch(() => {});
});

app.get('/groups/:username', (req, res) => res.json(groups.filter(g => g.members.includes(req.params.username))));

app.post(['/group/update_name', '/group/update_settings'], (req, res) => {
    const { groupId, adminUser, name, description, rules } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (name) group.name = name;
        if (description !== undefined) group.description = description;
        if (rules !== undefined) group.rules = rules;
        res.status(200).json(group);
        notifyGroupChange(groupId, adminUser);
        if (db) db.collection('groups').doc(groupId).update({ name: group.name, description: group.description, rules: group.rules }).catch(() => {});
    } else res.status(403).send('Erro');
});

app.post('/group/add_member', (req, res) => {
    const { groupId, adminUser, newMember } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (!group.members.includes(newMember)) group.members.push(newMember);
        res.status(200).json(group);
        notifyGroupChange(groupId, adminUser);
        if (db) db.collection('groups').doc(groupId).update({ members: group.members });
    } else res.status(403).send('Erro');
});

// --- MENSAGENS ---

app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    const target = isGroup ? groups.find(g => g.id === recipient) : users.find(u => u.username === recipient);
    if (!isGroup && target && target.blockedUsers && target.blockedUsers.includes(username)) return res.json({ status: 'ok' });
    let finalContent = content;
    if (isAudio || isImage || isVideo) {
        const b2Url = await uploadToB2(Buffer.from(content, 'base64'), `media_${Date.now()}_${username}`);
        if (b2Url) finalContent = b2Url;
    }
    const msgData = { id: Date.now(), from: username, to: recipient, content: finalContent, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(), read: false, delivered: false };
    messages.push(msgData);
    res.status(200).json({ status: 'ok' });
    if (db) db.collection('messages').doc(msgData.id.toString()).set(msgData).catch(() => {});
});

app.get('/conversation/:u1/:u2', (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));
    messages.forEach(m => {
        if (!m.isGroup && m.from === req.params.u2 && m.to === req.params.u1) {
            m.delivered = true;
            if (db) db.collection('messages').doc(m.id.toString()).update({ delivered: true }).catch(() => {});
        }
    });
    res.json(list);
});

app.get('/messages/unread/:username', (req, res) => {
    const me = req.params.username;
    const myGroupsList = groups.filter(g => g.members.includes(me));
    const unread = messages.filter(m => {
        const isToMe = !m.isGroup && m.to === me;
        const isToMyGroup = m.isGroup && myGroupsList.find(g => g.id === m.to) && m.from !== me;
        return (isToMe || isToMyGroup) && !m.read;
    }).map(m => {
        if(!m.delivered) {
            m.delivered = true;
            if (db) db.collection('messages').doc(m.id.toString()).update({ delivered: true }).catch(() => {});
        }
        if (m.isGroup) {
            const grp = myGroupsList.find(g => g.id === m.to);
            return { ...m, groupName: grp ? grp.name : "Grupo" };
        }
        return m;
    });
    res.json(unread);
});

app.post('/mark_read', (req, res) => {
    const { username, contact } = req.body;
    messages.forEach(m => {
        if (!m.isGroup && m.from === contact && m.to === username) m.read = true;
    });
    res.json({ status: 'ok' });
    if (db) {
        messages.filter(m => !m.isGroup && m.from === contact && m.to === username).forEach(m => {
            db.collection('messages').doc(m.id.toString()).update({ read: true }).catch(() => {});
        });
    }
});

// --- PÁGINAS ---

app.get('/download', (req, res) => {
    const apkLink = latestApkName ? `/b2file/${latestApkName}` : "#";
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-br">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>NOCTIS - Download Oficial</title>
            <style>
                body { background: #0A0E14; color: white; font-family: 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .container { background: rgba(30, 41, 59, 0.6); padding: 50px; border-radius: 30px; border: 1px solid #00D2FF; box-shadow: 0 0 30px rgba(0, 210, 255, 0.15); backdrop-filter: blur(15px); text-align: center; max-width: 400px; width: 90%; }
                .logo { width: 100px; height: 100px; background: linear-gradient(45deg, #00D2FF, #FF00FF); border-radius: 25px; margin: 0 auto 30px; display: flex; align-items: center; justify-content: center; font-size: 50px; box-shadow: 0 0 20px rgba(0, 210, 255, 0.4); }
                h1 { color: #00D2FF; letter-spacing: 3px; margin-bottom: 10px; font-size: 28px; }
                p { color: #94A3B8; font-size: 14px; margin-bottom: 40px; }
                .btn { background: linear-gradient(45deg, #00D2FF, #00A8CC); color: black; text-decoration: none; padding: 18px 30px; border-radius: 12px; font-weight: bold; display: inline-block; transition: 0.3s; text-transform: uppercase; letter-spacing: 1px; box-shadow: 0 4px 15px rgba(0, 210, 255, 0.3); }
                .btn:hover { transform: translateY(-3px); box-shadow: 0 8px 25px rgba(0, 210, 255, 0.5); }
                .version { margin-top: 25px; font-size: 11px; color: #475569; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="logo">🛰️</div>
                <h1>NOCTIS</h1>
                <p>O mensageiro blindado para quem valoriza a privacidade absoluta.</p>
                <a href="${apkLink}" class="btn">Baixar Versão Atual</a>
                <div class="version">Versão Estável: ${latestVersionCode} | Criptografia GCM-256</div>
            </div>
        </body>
        </html>
    `);
});

app.get('/b2file/:filename', async (req, res) => {
    try {
        if (!cachedBucketName) await initB2();
        const downloadResp = await b2.downloadFileByName({
            bucketName: cachedBucketName,
            fileName: req.params.filename,
            responseType: 'arraybuffer'
        });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(Buffer.from(downloadResp.data));
    } catch (e) { res.status(404).send('Off'); }
});

app.get('/admin', (req, res) => {
    res.send(`
        <body style="background: #0A0E14; color: white; font-family: 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px;">
            <div style="background: rgba(30, 41, 59, 0.7); padding: 40px; border-radius: 20px; border: 1px solid #00D2FF; box-shadow: 0 0 20px rgba(0, 210, 255, 0.2); backdrop-filter: blur(10px); width: 100%; max-width: 450px; text-align: center;">
                <h1 style="color: #00D2FF; margin-bottom: 30px; letter-spacing: 2px;">🛰️ MASTER CONTROL</h1>
                <div style="background: rgba(0,0,0,0.3); padding: 15px; border-radius: 10px; margin-bottom: 25px; text-align: left; font-size: 14px;">
                    <p style="margin: 5px 0;">🔥 Firebase: <span style="color: #00F260">${firebaseStatus}</span></p>
                    <p style="margin: 5px 0;">☁️ B2 Cloud: <span style="color: #00F260">${b2Status}</span></p>
                    <p style="margin: 5px 0;">📱 Versão Atual: <span style="color: #FF00FF">${latestVersionCode}</span></p>
                </div>
                <form id="uploadForm" style="display: flex; flex-direction: column; gap: 15px;">
                    <input name="versionCode" type="number" placeholder="Nova Versão" style="width: 100%; background: #0F172A; border: 1px solid #334155; color: white; padding: 12px; border-radius: 8px; outline: none; box-sizing: border-box;">
                    <input name="apkFile" type="file" accept=".apk" style="width: 100%; background: #0F172A; border: 1px solid #334155; color: white; padding: 10px; border-radius: 8px; outline: none; box-sizing: border-box; font-size: 12px;">
                    <input name="password" type="password" placeholder="Senha Master" style="width: 100%; background: #0F172A; border: 1px solid #334155; color: white; padding: 12px; border-radius: 8px; outline: none; box-sizing: border-box;">
                    <button type="submit" style="background: linear-gradient(45deg, #00D2FF, #00A8CC); color: black; border: none; padding: 15px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; margin-top: 10px;">🚀 SUBIR E LANÇAR ATUALIZAÇÃO</button>
                </form>
                <div id="progressBox" style="display: none; margin-top: 20px;">
                    <div style="width: 100%; background: #1E293B; height: 10px; border-radius: 5px; overflow: hidden;">
                        <div id="progressBar" style="width: 0%; height: 100%; background: #00F260; transition: 0.3s;"></div>
                    </div>
                    <p id="percent" style="font-size: 10px; color: #00F260; margin-top: 5px;">0%</p>
                </div>
                <p id="msg" style="margin-top: 20px; font-size: 12px; color: #94A3B8;"></p>
            </div>
            <script>
                const form = document.getElementById('uploadForm');
                const msg = document.getElementById('msg');
                const progressBox = document.getElementById('progressBox');
                const progressBar = document.getElementById('progressBar');
                const percentText = document.getElementById('percent');
                form.onsubmit = async (e) => {
                    e.preventDefault();
                    const formData = new FormData(form);
                    if(!formData.get('versionCode') || !formData.get('apkFile').name || !formData.get('password')) {
                        msg.style.color = "#FF4B2B"; msg.innerText = "⚠️ Preencha todos os campos."; return;
                    }
                    msg.style.color = "#94A3B8"; msg.innerText = "📡 Enviando...";
                    progressBox.style.display = "block";
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', '/admin/upload_apk', true);
                    xhr.timeout = 0;
                    xhr.upload.onprogress = (event) => {
                        if (event.lengthComputable) {
                            const percent = Math.round((event.loaded / event.total) * 100);
                            progressBar.style.width = percent + "%";
                            percentText.innerText = percent + "%";
                        }
                    };
                    xhr.onload = () => {
                        if (xhr.status === 200) {
                            msg.style.color = "#00F260"; msg.innerText = "✅ SUCESSO!";
                            setTimeout(() => location.reload(), 3000);
                        } else {
                            msg.style.color = "#FF4B2B"; msg.innerText = "❌ ERRO: " + xhr.responseText;
                        }
                    };
                    xhr.send(formData);
                };
            </script>
        </body>
    `);
});

app.get('/', (req, res) => {
    res.send(`<h1>🛰️ NOCTIS Hybrid v20.45</h1><p>Status: ONLINE ✅ | Vault: SECURE 🔐</p>`);
});

app.listen(port, () => console.log(`Noctis v20.43 pronto.`));
