const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Armazenamento em memória (limpa se o servidor reiniciar)
let users = []; // [{ username, password }]
let messages = [];

// ROTA: REGISTRO (Criar Conta)
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ status: 'error', message: 'Dados incompletos' });

    const userExists = users.find(u => u.username === username);
    if (userExists) {
        return res.status(400).json({ status: 'error', message: 'USUÁRIO_JÁ_REGISTRADO' });
    }

    users.push({ username, password });
    console.log(`Novo usuário: ${username}`);
    res.status(201).json({ status: 'ok', message: 'REGISTRO_CONCLUÍDO' });
});

// ROTA: LOGIN (Entrar)
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ status: 'error', message: 'Dados incompletos' });

    const user = users.find(u => u.username === username);

    if (!user) {
        return res.status(404).json({ status: 'error', message: 'USUÁRIO_NÃO_ENCONTRADO' });
    }

    if (user.password === password) {
        console.log(`Login: ${username}`);
        res.status(200).json({ status: 'ok', message: 'ACESSO_PERMITIDO' });
    } else {
        res.status(401).json({ status: 'error', message: 'SENHA_INCORRETA' });
    }
});

// Enviar mensagem
app.post('/send_message', (req, res) => {
    const { username, recipient, content } = req.body;
    const msg = {
        id: Date.now(),
        from: username,
        to: recipient,
        content,
        time: new Date().toLocaleTimeString()
    };
    messages.push(msg);
    res.status(200).json({ status: 'enviada' });
});

// Buscar mensagens recebidas
app.get('/messages/:username', (req, res) => {
    const inbox = messages.filter(m => m.to === req.params.username);
    res.json(inbox);
});

// Limpar Caixa
app.post('/clear_messages', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (user && user.password === password) {
        messages = messages.filter(m => m.to !== username);
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(401).json({ status: 'negado' });
    }
});

app.get('/', (req, res) => res.send('CyberServer v2.0 Ativo!'));
app.listen(port, () => console.log(`CyberServer na porta ${port}`));
