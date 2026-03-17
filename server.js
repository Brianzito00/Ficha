const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin'); // Importa o Firebase

const app = express();
const server = http.createServer(app); 
const io = new Server(server);

app.use(express.json({ limit: '10mb' })); 
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. INICIALIZAR O FIREBASE
// ==========================================
let db;
try {
    // O Render vai ler isto do Secret File que criaste!
    const serviceAccount = require('./firebase-key.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("🔥 Ligado ao Firebase com sucesso!");
} catch (error) {
    console.error("❌ ERRO: Ficheiro 'firebase-key.json' não encontrado. Configura no Secret Files do Render!");
    process.exit(1); // Para o servidor se não houver base de dados
}

// ==========================================
// 2. CATÁLOGO GERAL DE ITENS (Agora guardado no Firebase)
// ==========================================
let globalCatalog = { items: [], melee: [], ranged: [] };

// Carrega o catálogo do Firebase quando o servidor liga
async function carregarCatalogo() {
    try {
        const doc = await db.collection('config').doc('catalogo').get();
        if (doc.exists) {
            globalCatalog = doc.data();
            console.log("📦 Catálogo global carregado do Firebase!");
        } else {
            // Se ainda não existir no Firebase, cria um vazio
            await db.collection('config').doc('catalogo').set(globalCatalog);
        }
    } catch (e) {
        console.error("Erro ao carregar o catálogo do Firebase:", e);
    }
}
carregarCatalogo();

// Salva as armas e itens criados de volta no Firebase
function salvarCatalogo() {
    db.collection('config').doc('catalogo').set(globalCatalog)
        .catch(e => console.error("Erro ao salvar catálogo no Firebase:", e));
}

// ==========================================
// 3. ROTAS DA API (SISTEMA DE CONTAS NO FIREBASE)
// ==========================================

app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// Registar Novo Utilizador no Firebase
app.post('/api/registar', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const docRef = db.collection('usuarios').doc(usuario);
        const doc = await docRef.get();

        if (doc.exists) return res.json({ sucesso: false, erro: 'Este utilizador já existe!' });

        await docRef.set({ senha: senha, ficha: null });
        res.json({ sucesso: true });
    } catch (error) {
        console.error("Erro no registo:", error);
        res.json({ sucesso: false, erro: 'Erro ao registar na base de dados.' });
    }
});

// Login do Utilizador no Firebase
app.post('/api/login', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const docRef = db.collection('usuarios').doc(usuario);
        const doc = await docRef.get();

        if (!doc.exists || doc.data().senha !== senha) {
            return res.json({ sucesso: false, erro: 'Utilizador ou senha incorretos!' });
        }
        res.json({ sucesso: true, ficha: doc.data().ficha });
    } catch (error) {
        console.error("Erro no login:", error);
        res.json({ sucesso: false, erro: 'Erro interno no servidor.' });
    }
});

// Guardar Ficha no Firebase
app.post('/api/guardar_ficha', async (req, res) => {
    const { usuario, fichaData } = req.body;
    try {
        const docRef = db.collection('usuarios').doc(usuario);
        // O "merge: true" atualiza apenas a ficha sem apagar a senha!
        await docRef.set({ ficha: fichaData }, { merge: true }); 
        console.log(`💾 Ficha do jogador [${usuario}] salva no Firebase.`);
        res.json({ sucesso: true });
    } catch (error) {
        console.error("Erro ao guardar ficha:", error);
        res.json({ sucesso: false, erro: 'Erro ao guardar na base de dados.' });
    }
});

// ==========================================
// 4. COMUNICAÇÃO EM TEMPO REAL (SOCKET.IO)
// ==========================================
const playersData = {}; 

io.on('connection', (socket) => {
    console.log(`🟢 Utilizador ligou-se: ${socket.id}`);

    // --- CATÁLOGO COMPARTILHADO ---
    socket.emit('catalogo_inicial', globalCatalog);

    socket.on('novo_item_catalogo_global', (data) => {
        const cat = data.catType === 'item' ? 'items' : data.catType;
        if (!globalCatalog[cat].some(it => it.name.toLowerCase() === data.item.name.toLowerCase())) {
            globalCatalog[cat].push(data.item);
            salvarCatalogo(); // Salva logo no Firebase!
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
            socket.broadcast.emit('catalogo_inicial', globalCatalog); 
        }
    });

    // --- SINCRONIZAÇÃO COM O MESTRE ---
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

    socket.on('comando_mestre', (dados) => socket.broadcast.emit('comando_mestre', dados));
    socket.on('rolagem_feita', (dados) => { 
        io.emit('novo_log', dados); 
        io.emit('nova_rolagem', dados); 
    });

    // --- RECUPERAR FICHA PARA O MESTRE DO FIREBASE ---
    socket.on('request_player', async (codigo) => {
        if(playersData[codigo]) {
            socket.emit('update_mestre', playersData[codigo]);
        } else {
            try {
                const doc = await db.collection('usuarios').doc(codigo).get();
                if (doc.exists && doc.data().ficha) {
                    const f = doc.data().ficha;
                    const dadosRecuperados = {
                        codigo: codigo, nome: f.info.char_nome, foto: f.info.char_img, nex: f.info.char_nex, defesa: f.defense,
                        vida_atual: f.info.vida_atual, vida_max: f.info.vida_max, sani_atual: f.info.sani_atual, sani_max: f.info.sani_max,
                        status: f.charStatus, fullData: f
                    };
                    playersData[codigo] = dadosRecuperados;
                    socket.emit('update_mestre', dadosRecuperados);
                } else {
                    socket.broadcast.emit('mestre_pede_ficha', codigo);
                }
            } catch (e) {
                console.error("Erro ao buscar jogador no Firebase:", e);
            }
        }
    });

    socket.on('disconnect', () => console.log(`🔴 Utilizador desligou-se: ${socket.id}`));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor a rodar na porta ${PORT} (Com Firebase definitivo!)`);
});