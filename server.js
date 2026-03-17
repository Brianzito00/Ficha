const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app); 
const io = new Server(server);

// Permite leitura de JSON e define a pasta "public" onde estão os seus HTMLs
app.use(express.json({ limit: '10mb' })); 
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// BANCO DE DADOS LOCAL (APENAS PARA O CATÁLOGO GERAL DE ITENS)
// ==========================================
const CATALOG_FILE = path.join(__dirname, 'catalogo_global.json');
let globalCatalog = { items: [], melee: [], ranged: [] };

if (fs.existsSync(CATALOG_FILE)) {
    try {
        const data = fs.readFileSync(CATALOG_FILE, 'utf8');
        globalCatalog = JSON.parse(data);
        console.log("📦 Catálogo global carregado com sucesso!");
    } catch (err) {
        console.error("Erro ao ler o catálogo:", err);
    }
} else {
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(globalCatalog, null, 2));
}

function salvarCatalogo() {
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(globalCatalog, null, 2));
}

// ==========================================
// ROTAS DA API (SISTEMA DE FICHA / FIREBASE)
// ==========================================

// Rota de salvamento. Se o seu Firebase guarda a ficha direto pelo HTML, 
// esta rota apenas responde OK para não dar erro.
app.post('/api/guardar_ficha', (req, res) => {
    // Caso precise de código backend do Firebase futuramente, entra aqui.
    res.status(200).send({ sucesso: true, message: 'Ficha recebida no servidor.' });
});

// ==========================================
// COMUNICAÇÃO EM TEMPO REAL (SOCKET.IO)
// ==========================================
const playersData = {}; 

io.on('connection', (socket) => {
    console.log(`🟢 Utilizador ligou-se: ${socket.id}`);

    // Envia o catálogo atualizado para o jogador assim que ele se conecta
    socket.emit('catalogo_inicial', globalCatalog);

    // --- SISTEMA DE CATÁLOGO COMPARTILHADO ---
    socket.on('novo_item_catalogo_global', (data) => {
        const cat = data.catType === 'item' ? 'items' : data.catType;
        
        // Evita duplicatas no servidor
        if (!globalCatalog[cat].some(it => it.name.toLowerCase() === data.item.name.toLowerCase())) {
            globalCatalog[cat].push(data.item);
            salvarCatalogo();
            console.log("🛠️ Novo item salvo no catálogo global:", data.item.name);
            socket.broadcast.emit('sync_item_catalogo_global', data);
        }
    });

    socket.on('sync_catalogo_reverso', (clientItems) => {
        let mudou = false;
        const mesclar = (catName) => {
            if (clientItems[catName] && Array.isArray(clientItems[catName])) {
                clientItems[catName].forEach(cItem => {
                    if (!globalCatalog[catName].some(sItem => sItem.name.toLowerCase() === cItem.name.toLowerCase())) {
                        globalCatalog[catName].push(cItem);
                        mudou = true;
                    }
                });
            }
        };
        mesclar('items'); mesclar('melee'); mesclar('ranged');
        if (mudou) {
            salvarCatalogo();
            console.log("🔄 Servidor auto-curado com itens dos jogadores!");
            socket.broadcast.emit('catalogo_inicial', globalCatalog); 
        }
    });

    // --- SINCRONIZAÇÃO DA FICHA PARA O MESTRE ---
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

    // --- ROLAGEM DE DADOS ---
    socket.on('rolagem_feita', (dados) => { 
        io.emit('novo_log', dados); 
        io.emit('nova_rolagem', dados); 
    });

    // --- RECUPERAÇÃO DE FICHA PELO MESTRE ---
    socket.on('request_player', (codigo) => {
        if(playersData[codigo]) {
            socket.emit('update_mestre', playersData[codigo]);
        } else {
            socket.broadcast.emit('mestre_pede_ficha', codigo);
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
