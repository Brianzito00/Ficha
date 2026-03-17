const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app); 
const io = new Server(server);

// Permite que o servidor leia ficheiros JSON (usados no login/registo e ficha)
app.use(express.json({ limit: '10mb' })); 
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// BANCO DE DADOS LOCAL (USUÁRIOS E FICHAS)
// ==========================================
const dbPath = path.join(__dirname, 'usuarios.json');

// Função para ler o banco de dados de contas
function lerDB() {
    if (!fs.existsSync(dbPath)) return {};
    return JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
}

// Função para guardar no banco de dados de contas
function guardarDB(dados) {
    fs.writeFileSync(dbPath, JSON.stringify(dados, null, 2));
}

// ==========================================
// BANCO DE DADOS LOCAL (CATÁLOGO GERAL DE ITENS)
// ==========================================
const CATALOG_FILE = path.join(__dirname, 'catalogo_global.json');
let globalCatalog = { items: [], melee: [], ranged: [] };

// Carrega o catálogo existente ao ligar o servidor
if (fs.existsSync(CATALOG_FILE)) {
    try {
        const data = fs.readFileSync(CATALOG_FILE, 'utf8');
        globalCatalog = JSON.parse(data);
        console.log("📦 Catálogo global carregado com sucesso!");
    } catch (err) {
        console.error("Erro ao ler o catálogo:", err);
    }
} else {
    // Se não existir, cria um vazio
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(globalCatalog, null, 2));
}

function salvarCatalogo() {
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(globalCatalog, null, 2));
}


// ==========================================
// ROTAS DA API (SISTEMA DE CONTAS E FICHA)
// ==========================================

// Redireciona a página inicial para o LOGIN agora
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

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
        console.log(`💾 Ficha do jogador [${usuario}] salva no servidor.`);
        res.json({ sucesso: true });
    } else {
        res.json({ sucesso: false, erro: 'Utilizador não encontrado.' });
    }
});


// ==========================================
// COMUNICAÇÃO EM TEMPO REAL (SOCKET.IO)
// ==========================================
const playersData = {}; 

io.on('connection', (socket) => {
    console.log(`🟢 Utilizador ligou-se: ${socket.id}`);

    // Envia o catálogo atualizado para o jogador assim que ele se conecta
    socket.emit('catalogo_inicial', globalCatalog);

    // --- 1. SISTEMA DE CATÁLOGO COMPARTILHADO ---
    socket.on('novo_item_catalogo_global', (data) => {
        console.log("🛠️ Novo item adicionado ao catálogo global:", data.item.name);
        
        // Adiciona à memória do servidor
        if (data.catType === 'item') globalCatalog.items.push(data.item);
        else if (data.catType === 'melee') globalCatalog.melee.push(data.item);
        else if (data.catType === 'ranged') globalCatalog.ranged.push(data.item);
        
        salvarCatalogo(); // Salva no arquivo json

        // Envia este item novo para TODOS os outros jogadores conectados
        socket.broadcast.emit('sync_item_catalogo_global', data);
    });

    // --- 2. SINCRONIZAÇÃO DA FICHA PARA O MESTRE ---
    socket.on('status_change', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo] = dados;
            socket.broadcast.emit('update_mestre', dados); 
        }
    });

    socket.on('mestre_force_sync', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo] = dados;
            socket.broadcast.emit('update_mestre', dados); 
            socket.broadcast.emit('mestre_force_sync_player', dados); 
        }
    });

    socket.on('comando_mestre', (dados) => { 
        socket.broadcast.emit('comando_mestre', dados); 
    });

    // --- 3. ROLAGEM DE DADOS ---
    socket.on('rolagem_feita', (dados) => { 
        io.emit('novo_log', dados); 
        io.emit('nova_rolagem', dados); 
    });

    // --- 4. RECUPERAÇÃO DE FICHA PELO MESTRE ---
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
            } else {
                socket.broadcast.emit('mestre_pede_ficha', codigo);
            }
        }
    });

    socket.on('disconnect', () => { 
        console.log(`🔴 Utilizador desligou-se: ${socket.id}`); 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor de Ordem Paranormal a rodar na porta ${PORT}`);
});
