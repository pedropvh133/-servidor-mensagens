const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Armazenamento em memória (limpa se o servidor reiniciar)
let users = [];
let messages = [];

// Criar/Verificar usuário
app.post('/create_user', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).send('Nome obrigatório');

    const userExists = users.find(u => u === username);
    if (!userExists) {
        users.push(username);
        console.log(`Novo usuário: ${username}`);
    }

    res.status(200).json({ status: 'ok', user: username });
});

// Enviar mensagem
app.post('/send_message', (req, res) => {
    const { username, recipient, content } = req.body;
    if (!username || !recipient || !content) return res.status(400).send('Dados incompletos');

    const msg = {
        id: Date.now(),
        from: username,
        to: recipient,
        content,
        time: new Date().toLocaleTimeString()
    };

    messages.push(msg);
    console.log(`Mensagem de ${username} para ${recipient}`);
    res.status(200).json({ status: 'enviada' });
});

// Buscar mensagens recebidas
app.get('/messages/:username', (req, res) => {
    const { username } = req.params;
    const inbox = messages.filter(m => m.to === username);
    res.json(inbox);
});

// Rota de teste
app.get('/', (req, res) => res.send('Servidor de Mensagens Ativo!'));

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
