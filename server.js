const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Permite que o Express entenda JSON no corpo das requisições (para o fetch de salvar ficha)
app.use(express.json({ limit: '10mb' }));

// Serve os ficheiros estáticos (HTML, CSS, JS, imagens) da pasta 'public'
// Certifica-te que o teu index.html está dentro de uma pasta chamada "public"
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// BANCO DE DADOS LOCAL DO CATÁLOGO GERAL
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
// ROTAS DA API (Exemplo para salvar ficha)
// ==========================================
app.post('/api/guardar_ficha', (req, res) => {
    const { usuario, fichaData } = req.body;
    if (!usuario) return res.status(400).send("Usuário não informado.");
    
    // Aqui você integraria com o Firebase Admin SDK (Firestore/Realtime Database)
    // Exemplo: admin.firestore().collection('fichas').doc(usuario).set(fichaData);
    
    console.log(`💾 Ficha do jogador [${usuario}] recebida no servidor.`);
    res.status(200).send({ message: 'Ficha guardada com sucesso' });
});

// ==========================================
// COMUNICAÇÃO EM TEMPO REAL (SOCKET.IO)
// ==========================================
io.on('connection', (socket) => {
    console.log(`🟢 Novo utilizador conectado: ${socket.id}`);

    // Quando um jogador conecta, envia o catálogo atualizado para ele
    socket.emit('catalogo_inicial', globalCatalog);

    // ==========================================
    // 1. SISTEMA DE CATÁLOGO COMPARTILHADO
    // ==========================================
    socket.on('novo_item_catalogo_global', (data) => {
        console.log("🛠️ Novo item criado e adicionado ao catálogo:", data.item.name);
        
        // Adiciona ao banco de dados em memória do servidor
        if (data.catType === 'item') globalCatalog.items.push(data.item);
        else if (data.catType === 'melee') globalCatalog.melee.push(data.item);
        else if (data.catType === 'ranged') globalCatalog.ranged.push(data.item);
        
        // Salva no ficheiro JSON para não perder ao reiniciar o servidor
        salvarCatalogo();

        // Envia este item novo para TODOS os outros jogadores conectados
        socket.broadcast.emit('sync_item_catalogo_global', data);
    });

    // ==========================================
    // 2. SISTEMA DE ROLAGEM DE DADOS
    // ==========================================
    socket.on('rolagem_feita', (dados) => {
        // Envia o resultado do dado para todos (Mestre e outros jogadores)
        io.emit('nova_rolagem', dados);
    });

    // ==========================================
    // 3. SINCRONIZAÇÃO DA FICHA PARA O MESTRE
    // ==========================================
    socket.on('status_change', (dados) => {
        // Envia os status atuais do jogador para o mestre ver
        socket.broadcast.emit('update_mestre', dados);
    });

    socket.on('request_player', (viewCode) => {
        // O mestre pediu a ficha completa de um jogador
        socket.broadcast.emit('mestre_pede_ficha', viewCode);
    });

    socket.on('mestre_force_sync', (payload) => {
        // O mestre forçou uma alteração na ficha do jogador
        socket.broadcast.emit('mestre_force_sync_player', payload);
    });

    socket.on('comando_mestre', (dados) => {
        // O mestre alterou a vida/sanidade do jogador remotamente
        socket.broadcast.emit('comando_mestre', dados);
    });

    socket.on('disconnect', () => {
        console.log(`🔴 Utilizador desconectado: ${socket.id}`);
    });
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor de Ordem Paranormal a rodar na porta ${PORT}`);
});
