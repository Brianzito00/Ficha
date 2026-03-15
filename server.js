const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app); 
const io = new Server(server);

// Permite que o servidor leia ficheiros JSON (usados no login/registo)
app.use(express.json({ limit: '10mb' })); 
app.use(express.static(path.join(__dirname, 'public')));

// Caminho para o nosso "Banco de Dados" em ficheiro
const dbPath = path.join(__dirname, 'usuarios.json');

// Função para ler o banco de dados
function lerDB() {
    if (!fs.existsSync(dbPath)) return {};
    return JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
}

// Função para guardar no banco de dados
function guardarDB(dados) {
    fs.writeFileSync(dbPath, JSON.stringify(dados, null, 2));
}

// Redireciona a página inicial para o LOGIN agora
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// --- SISTEMA DE CONTAS (API) ---

// Registar
app.post('/api/registar', (req, res) => {
    const { usuario, senha } = req.body;
    const db = lerDB();

    if (db[usuario]) {
        return res.json({ sucesso: false, erro: 'Este utilizador já existe!' });
    }

    db[usuario] = { senha: senha, ficha: null }; // Cria o utilizador sem ficha no início
    guardarDB(db);
    res.json({ sucesso: true });
});

// Login
app.post('/api/login', (req, res) => {
    const { usuario, senha } = req.body;
    const db = lerDB();

    if (!db[usuario] || db[usuario].senha !== senha) {
        return res.json({ sucesso: false, erro: 'Utilizador ou senha incorretos!' });
    }
    
    res.json({ sucesso: true, ficha: db[usuario].ficha });
});

// Guardar Ficha no Perfil
app.post('/api/guardar_ficha', (req, res) => {
    const { usuario, fichaData } = req.body;
    const db = lerDB();

    if (db[usuario]) {
        db[usuario].ficha = fichaData;
        guardarDB(db);
        res.json({ sucesso: true });
    } else {
        res.json({ sucesso: false, erro: 'Utilizador não encontrado.' });
    }
});


// --- SISTEMA EM TEMPO REAL (SOCKET.IO) ---
const playersData = {}; 

io.on('connection', (socket) => {
    console.log('🟢 Utilizador ligou-se:', socket.id);

    socket.on('status_change', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo] = dados;
            io.emit('update_mestre', dados); 
        }
    });

    socket.on('mestre_force_sync', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo] = dados;
            io.emit('update_mestre', dados); 
            io.emit('mestre_force_sync_player', dados); 
        }
    });

    socket.on('comando_mestre', (dados) => { io.emit('comando_mestre', dados); });
    socket.on('rolagem_feita', (dados) => { io.emit('novo_log', dados); });

    socket.on('request_player', (codigo) => {
        if(playersData[codigo]) {
            socket.emit('update_mestre', playersData[codigo]);
        } else {
            // Se o servidor acabou de reiniciar, tenta ler a ficha salva no DB
            const db = lerDB();
            if (db[codigo] && db[codigo].ficha) {
                const f = db[codigo].ficha;
                const dadosRecuperados = {
                    codigo: codigo,
                    nome: f.info.char_nome,
                    foto: f.info.char_img,
                    nex: f.info.char_nex,
                    defesa: f.defense,
                    vida_atual: f.info.vida_atual, vida_max: f.info.vida_max,
                    sani_atual: f.info.sani_atual, sani_max: f.info.sani_max,
                    status: f.charStatus,
                    fullData: f
                };
                playersData[codigo] = dadosRecuperados;
                socket.emit('update_mestre', dadosRecuperados);
            }
        }
    });

    socket.on('disconnect', () => { console.log('🔴 Utilizador desligou-se:', socket.id); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor a correr na porta ${PORT}!`);
});
