const { Client } = require('pg');
const prompt = require('prompt-sync')();

let usuarioLogado = null;

function criarCliente() {
    return new Client({
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        password: 'sua_senha',
        database: 'almoxarifado_db'
    });
}

async function login() {
    const client = criarCliente();
    try {
        await client.connect();
        console.log('\nLOGIN DO SISTEMA');
        const username = prompt('Usuário: ');
        const senha = prompt('Senha: ', { echo: '*' });

        const res = await client.query(
            'SELECT id, username, perfil FROM usuarios WHERE username = $1 AND senha = $2',
            [username, senha]
        );

        if (res.rows.length > 0) {
            usuarioLogado = res.rows[0];
            console.log(`\nBem-vindo, ${usuarioLogado.username}! Perfil: ${usuarioLogado.perfil}`);
            return true;
        } else {
            console.log('Credenciais inválidas.');
            return false;
        }
    } catch (erro) {
        console.log('Erro na autenticação:', erro.message);
        return false;
    } finally {
        await client.end();
    }
}

async function listarProdutos() {
    const client = criarCliente();
    try {
        await client.connect();
        
        console.log('\nFILTROS DE BUSCA (Deixe em branco para ignorar)');
        const filtroNome = prompt('Filtrar por nome: ');
        const limite = parseInt(prompt('Quantidade de itens por página (Padrão 5): ')) || 5;
        const pagina = parseInt(prompt('Número da página (Padrão 1): ')) || 1;
        const offset = (pagina - 1) * limite;

        let queryText = 'SELECT * FROM produtos WHERE 1=1';
        let params = [];
        let paramCount = 1;

        if (filtroNome) {
            queryText += ` AND nome ILIKE $${paramCount}`;
            params.push(`%${filtroNome}%`);
            paramCount++;
        }

        queryText += ` ORDER BY nome LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(limite, offset);

        const res = await client.query(queryText, params);

        console.log('\nESTOQUE ATUAL DE PRODUTOS');
        if (res.rows.length === 0) {
            console.log('Nenhum produto encontrado nesta página/filtro.');
        } else {
            res.rows.forEach(p => {
                console.log(`[${p.id}] ${p.nome} | Tipo: ${p.tipo} | Qtd: ${p.estoque} | Preço: R$ ${p.preco}`);
            });
            console.log(`--- Página ${pagina} ---`);
        }
    } catch (erro) {
        console.log('Erro ao listar produtos:', erro.message);
    } finally {
        await client.end();
    }
}

async function cadastrarProduto() {
    if (usuarioLogado.perfil !== 'Administrador') {
        console.log('Acesso Negado: Apenas administradores podem cadastrar produtos.');
        return;
    }

    const client = criarCliente();
    try {
        await client.connect();
        console.log('\nCADASTRAR NOVO PRODUTO');
        const nome = prompt('Nome do produto: ');
        const tipo = prompt('Tipo/Categoria: ');
        const preco = parseFloat(prompt('Preço unitário: '));
        const estoque = parseInt(prompt('Estoque inicial: ')) || 0;
        const descricao = prompt('Descrição: ');

        if (!nome || !tipo || isNaN(preco)) {
            console.log('Dados obrigatórios inválidos.');
            return;
        }

        const res = await client.query(
            `INSERT INTO produtos (nome, tipo, preco, estoque, descricao) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [nome, tipo, preco, estoque, descricao]
        );

        console.log(`\nProduto cadastrado com sucesso! ID: ${res.rows[0].id}`);
    } catch (erro) {
        console.log('Erro ao cadastrar:', erro.message);
    } finally {
        await client.end();
    }
}

async function excluirProduto() {
    if (usuarioLogado.perfil !== 'Administrador') {
        console.log('Acesso Negado: Apenas administradores podem excluir registros.');
        return;
    }

    const client = criarCliente();
    try {
        await client.connect();
        console.log('\nEXCLUIR PRODUTO');
        const id = parseInt(prompt('ID do produto a ser deletado: '));

        const busca = await client.query('SELECT nome FROM produtos WHERE id = $1', [id]);
        if (busca.rows.length === 0) {
            console.log('Produto não encontrado.');
            return;
        }

        const conf = prompt(`Tem certeza que deseja deletar "${busca.rows[0].nome}"? (s/n): `);
        if (conf.toLowerCase() !== 's') {
            console.log('Operação cancelada.');
            return;
        }

        await client.query('DELETE FROM produtos WHERE id = $1', [id]);
        console.log('Produto removido permanentemente.');
    } catch (erro) {
        console.log('Erro ao excluir produto:', erro.message);
    } finally {
        await client.end();
    }
}

async function registrarSaida() {
    const client = criarCliente();
    try {
        await client.connect();
        console.log('\nREGISTRAR SAÍDA DE MATERIAL (BAIXA ESTOQUE)');
        const produtoId = parseInt(prompt('ID do Produto: '));
        const qtdSolicitada = parseInt(prompt('Quantidade a ser retirada: '));

        if (isNaN(produtoId) || isNaN(qtdSolicitada) || qtdSolicitada <= 0) {
            console.log('Parâmetros de quantidade ou ID inválidos.');
            return;
        }

        await client.query('BEGIN');

        const buscaProd = await client.query(
            'SELECT nome, estoque FROM produtos WHERE id = $1 FOR UPDATE', 
            [produtoId]
        );

        if (buscaProd.rows.length === 0) {
            console.log('Produto não encontrado no sistema.');
            await client.query('ROLLBACK');
            return;
        }

        const saldoDisponivel = buscaProd.rows[0].estoque;

        if (qtdSolicitada > saldoDisponivel) {
            console.log(`\nSaída não permitida: estoque insuficiente. Disponível: ${saldoDisponivel}. Solicitado: ${qtdSolicitada}.`);
            await client.query('ROLLBACK');
            return;
        }

        await client.query(
            'UPDATE produtos SET estoque = estoque - $1 WHERE id = $2',
            [qtdSolicitada, produtoId]
        );

        await client.query(
            `INSERT INTO movimentacoes (produto_id, tipo_movimentacao, quantidade, usuario_id) 
             VALUES ($1, 'SAÍDA', $2, $3)`,
            [produtoId, qtdSolicitada, usuarioLogado.id]
        );

        await client.query('COMMIT');
        console.log('\nSaída registrada com sucesso no sistema!');
    } catch (erro) {
        await client.query('ROLLBACK');
        console.log('Falha na transação de saída:', erro.message);
    } finally {
        await client.end();
    }
}

async function emitirHistorico() {
    const client = criarCliente();
    try {
        await client.connect();
        const res = await client.query(
            `SELECT m.id, p.nome as produto, m.tipo_movimentacao, m.quantidade, m.data_hora, u.username as operador
             FROM movimentacoes m
             JOIN produtos p ON m.produto_id = p.id
             JOIN usuarios u ON m.usuario_id = u.id
             ORDER BY m.data_hora DESC`
        );

        console.log('\nHISTÓRICO GERAL DE MOVIMENTAÇÕES (RASTREAMENTO)');
        if (res.rows.length === 0) {
            console.log('Nenhuma movimentação registrada.');
        } else {
            res.rows.forEach(log => {
                console.log(`[${log.data_hora.toLocaleString()}] - ${log.tipo_movimentacao} | Item: ${log.produto} | Qtd: ${log.quantidade} | Resp: ${log.operador}`);
            });
        }
    } catch (erro) {
        console.log('Erro ao puxar logs:', erro.message);
    } finally {
        await client.end();
    }
}

async function main() {
    console.clear();
    console.log('============================================');
    console.log('   SISTEMA DE ALMOXARIFADO E LOGÍSTICA SENAI  ');
    console.log('============================================');
    
    let autenticado = false;
    while (!autenticado) {
        autenticado = await login();
        if (!autenticado) {
            const tentarNovamente = prompt('Deseja tentar novamente? (s/n): ');
            if (tentarNovamente.toLowerCase() !== 's') return;
        }
    }

    let rodando = true;
    while (rodando) {
        console.log(`\n============================================`);
        console.log(`USUÁRIO ATUAL: ${usuarioLogado.username.toUpperCase()} (${usuarioLogado.perfil})`);
        console.log(`============================================`);
        console.log('1 - Consultar Estoque (Listar/Filtros)');
        console.log('2 - Registrar Saída de Produto (Validação de Saldo)');
        console.log('3 - Cadastrar Novo Item (Apenas Admin)');
        console.log('4 - Excluir Registro de Item (Apenas Admin)');
        console.log('5 - Visualizar Histórico e Rastreabilidade');
        console.log('0 - Desconectar e Sair');
        console.log('============================================');

        const opcao = prompt('Escolha uma opção: ');

        switch (opcao) {
            case '1': await listarProdutos(); break;
            case '2': await registrarSaida(); break;
            case '3': await cadastrarProduto(); break;
            case '4': await excluirProduto(); break;
            case '5': await emitirHistorico(); break;
            case '0':
                rodando = false;
                console.log('\nSessão encerrada com segurança.');
                break;
            default:
                console.log('Opção indisponível.');
        }
    }
}

main();