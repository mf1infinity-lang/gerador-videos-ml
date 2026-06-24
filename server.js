const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── utilidades ────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { res(JSON.parse(data)); } catch { res({}); }
    });
    req.on('error', rej);
  });
}

function json(res, status, body) {
  const str = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':'Content-Type'
  });
  res.end(str);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Anthropic ─────────────────────────────────
async function gerarRoteiro(nomePeca, antKey) {
  const prompt = `Crie um roteiro curto para vídeo de 10 segundos sobre uma peça automotiva.
PRODUTO: ${nomePeca}
O roteiro deve ter 3 frases curtas, formando um texto corrido:
1. Comece com um gancho forte, citando um problema ou sintoma relacionado à peça.
2. Explique rapidamente a função ou o benefício do produto.
3. Termine citando a loja Frídom e usando um estímulo de urgência ou compra.
REGRA PRINCIPAL DE PRONÚNCIA
O texto será falado por uma inteligência artificial. Por isso, escreva todas as palavras exatamente do jeito que devem ser pronunciadas em português do Brasil.
Exemplos: Freedom → Frídom | ABS → A B S | V6 → Vê seis | 3.0 → três ponto zero | 12V → doze volts
REGRAS OBRIGATÓRIAS
* O roteiro completo deve caber naturalmente em um vídeo de 10 segundos.
* Use frases curtas, simples e fáceis de pronunciar.
* Use aproximadamente 25 palavras no total.
* Escreva Frídom no lugar de Freedom.
* Não repita sempre "antes que o estoque acabe". Varie a chamada final.
* Entregue somente o roteiro final, sem título, explicações, tópicos ou observações.
EXEMPLO: Motor falhando ou sem força? A bomba mantém o combustível chegando corretamente. Garanta agora na Frídom para não ficar com o veículo parado.`;

  const body = JSON.stringify({
    model:      'claude-haiku-4-5',
    max_tokens: 200,
    messages:   [{ role: 'user', content: prompt }]
  });

  const data = await httpRequest({
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers: {
      'Content-Type':      'application/json',
      'Content-Length':    Buffer.byteLength(body),
      'x-api-key':         antKey,
      'anthropic-version': '2023-06-01'
    }
  }, body);

  if (data.error) throw new Error(data.error.message || 'Erro Anthropic');
  return data.content[0].text.trim();
}

// ── Higgsfield helpers ────────────────────────
function hgHeaders(id, secret) {
  const credentials = Buffer.from(`${id}:${secret}`).toString('base64');
  return {
    'Content-Type':  'application/json',
    'Authorization': `Basic ${credentials}`
  };
}

async function hgPost(endpoint, body, id, secret) {
  const str = JSON.stringify(body);
  return httpRequest({
    hostname: 'cloud.higgsfield.ai',
    path:     endpoint,
    method:   'POST',
    headers: { ...hgHeaders(id, secret), 'Content-Length': Buffer.byteLength(str) }
  }, str);
}

async function hgPoll(jobId, id, secret, maxTentativas = 80, intervalo = 6000) {
  for (let i = 0; i < maxTentativas; i++) {
    await sleep(intervalo);
    const data = await httpRequest({
      hostname: 'cloud.higgsfield.ai',
      path:     `/v1/jobs/${jobId}`,
      method:   'GET',
      headers:  hgHeaders(id, secret)
    });
    console.log(`  poll ${i+1}: status=${data.status}`);
    if (data.status === 'completed') return data;
    if (data.status === 'failed')    throw new Error(`Job falhou: ${JSON.stringify(data)}`);
  }
  throw new Error('Timeout na geração');
}

// ── HTTP helper (sem axios) ───────────────────
function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ _raw: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Servidor HTTP ─────────────────────────────
const server = http.createServer(async (req, res) => {

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Servir index.html
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // ── /api/roteiro ──────────────────────────
  if (req.method === 'POST' && req.url === '/api/roteiro') {
    try {
      const { nomePeca, antKey } = await readBody(req);
      console.log(`[roteiro] ${nomePeca}`);
      const roteiro = await gerarRoteiro(nomePeca, antKey);
      console.log(`[roteiro] ok: ${roteiro.slice(0,50)}...`);
      json(res, 200, { roteiro });
    } catch(e) {
      console.error('[roteiro] erro:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ── /api/imagem ───────────────────────────
  if (req.method === 'POST' && req.url === '/api/imagem') {
    try {
      const { nomePeca, dimensoes, modeloBase64, pecaBase64, hgId, hgSecret } = await readBody(req);
      console.log(`[imagem] ${nomePeca}`);

      const prompt = `Crie 1 imagem individual, em proporção 9:16, estilo UGC realista, como foto natural feita com celular para anúncio de autopeças.

Use a modelo da primeira imagem de referência como base principal. Mantenha exatamente a mesma aparência facial, cabelo, corpo e estilo.

A imagem deve mostrar a modelo segurando ou exibindo a peça automotiva da segunda imagem de referência: ${nomePeca}.

A peça deve manter proporção realista com tamanho real aproximado: ${dimensoes}. Mantenha aparência intacta, formato original, cor original, sem deformações.

A modelo deve aparecer em pose natural de UGC: segurando a peça com as duas mãos ou mostrando para a câmera.

Ambiente: balcão de loja de autopeças ou oficina organizada. Iluminação natural. Visual limpo e confiável.

Estilo UGC profissional, aparência de foto real tirada por celular moderno. Proporção 9:16 vertical.
Não adicionar textos, logos, marca d'água. Não criar mãos deformadas.`;

      // Remove prefixo data:image/...;base64,
      const modeloData = modeloBase64.includes(',') ? modeloBase64.split(',')[1] : modeloBase64;
      const pecaData   = pecaBase64.includes(',')   ? pecaBase64.split(',')[1]   : pecaBase64;

      const jobResp = await hgPost('/v1/generate/image', {
        model:        'nano_banana_pro',
        prompt,
        aspect_ratio: '9:16',
        count:        1,
        medias: [
          { role: 'reference', value: modeloData },
          { role: 'reference', value: pecaData }
        ]
      }, hgId, hgSecret);

      console.log('[imagem] job criado:', JSON.stringify(jobResp));

      if (!jobResp.id) throw new Error(`Higgsfield não retornou job id: ${JSON.stringify(jobResp)}`);

      const result = await hgPoll(jobResp.id, hgId, hgSecret);
      const url = result.outputs?.[0]?.url
               || result.results?.[0]?.url
               || result.url
               || result.output_url;

      if (!url) throw new Error(`URL da imagem não encontrada: ${JSON.stringify(result)}`);
      console.log('[imagem] ok:', url);
      json(res, 200, { url });
    } catch(e) {
      console.error('[imagem] erro:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ── /api/video ────────────────────────────
  if (req.method === 'POST' && req.url === '/api/video') {
    try {
      const { nomePeca, imagemUrl, roteiro, hgId, hgSecret } = await readBody(req);
      console.log(`[video] ${nomePeca}`);

      const prompt = `Crie 1 vídeo vertical 9:16, estilo UGC realista, com exatamente 10 segundos, usando a imagem enviada como única referência visual.

Mantenha a modelo e a peça automotiva (${nomePeca}) idênticas à imagem original.

REGRA ABSOLUTA: a peça deve permanecer durante todo o vídeo exatamente no mesmo ângulo da imagem original. Não girar, inclinar ou virar a peça.

A câmera pode fazer somente uma aproximação frontal muito leve, de no máximo 5%.

A modelo deve falar desde o primeiro segundo, olhando para a câmera, com sincronização labial natural em português do Brasil.

ESTRUTURA:
0s a 3s: modelo inicia a fala olhando para a câmera, peça imóvel.
3s a 7s: câmera faz aproximação frontal mínima e lenta.
7s a 10s: câmera retorna ao enquadramento inicial, modelo termina a fala.

FALA: ${roteiro}

Resultado: vídeo UGC natural e realista, sem aparência de inteligência artificial.`;

      const jobResp = await hgPost('/v1/generate/video', {
        model:        'kling3_0',
        prompt,
        duration:     10,
        aspect_ratio: '9:16',
        medias: [{ role: 'start_image', value: imagemUrl }]
      }, hgId, hgSecret);

      console.log('[video] job criado:', JSON.stringify(jobResp));
      if (!jobResp.id) throw new Error(`Higgsfield não retornou job id: ${JSON.stringify(jobResp)}`);

      const result = await hgPoll(jobResp.id, hgId, hgSecret, 90, 8000);
      const url = result.outputs?.[0]?.url
               || result.results?.[0]?.url
               || result.url
               || result.output_url;

      if (!url) throw new Error(`URL do vídeo não encontrada: ${JSON.stringify(result)}`);
      console.log('[video] ok:', url);
      json(res, 200, { url });
    } catch(e) {
      console.error('[video] erro:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // 404
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n✅ Servidor rodando em http://localhost:${PORT}`);
  console.log('   Abra esse endereço no navegador\n');
});
