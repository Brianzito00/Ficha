const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public')); // Serve o HTML criado acima

io.on('connection', (socket) => {
    console.log('Alguém conectou');

    // Quando o jogador rola um dado
    socket.on('rolagem_feita', (dados) => {
        // Envia para TODOS (incluindo o mestre)
        io.emit('novo_log', dados); 
    });

    // Quando o jogador muda a vida
    socket.on('status_change', (dados) => {
        io.emit('update_mestre', dados);
    });
});

http.listen(3000, () => {
    console.log('Rodando na porta 3000');
});