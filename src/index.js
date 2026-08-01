const PROMPT_EXTRACTION = `Tu es un extracteur de données structurées spécialisé dans le commerce des ressources naturelles africaines (agriculture, minerais, énergie, pêche, bois, logistique portuaire liée à ces filières). Tu reçois un texte brut et tu dois en extraire toutes les entités nommées qui ressemblent à une organisation.

RÈGLES :
- N'invente JAMAIS une information absente du texte. Si un champ n'est pas mentionné, mets null.
- Classe CHAQUE entité trouvée dans "tipo_entidade" avec honnêteté — inclue aussi bien les entreprises privées que les institutions, le tri se fait après, pas par toi.
- Classe aussi honnêtement "setor_recurso_natural" — si l'entité n'a clairement aucun lien avec les ressources naturelles (ex: cabinet d'avocats généraliste, hôtel, banque de détail), mets "nao_aplicavel". Ne force pas une catégorie qui ne correspond pas.
- Le champ "secteur" doit être court et normalisé (ex: "caju", "minerais", "logística portuária").

TEXTE:
`;

const SCHEMA_EXTRACAO = {
  type: 'json_schema',
  json_schema: {
    name: 'entidades_extraidas',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entidades: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              nom_original: { type: 'string', description: 'Nom propre exact tel que dans le texte, jamais une description générique' },
              tipo_entidade: {
                type: 'string',
                enum: ['empresa_privada', 'instituicao_publica', 'associacao_ou_ong', 'outro'],
                description: 'empresa_privada = entreprise commerciale privée uniquement.',
              },
              setor_recurso_natural: {
                type: 'string',
                enum: ['agricultura', 'minerais', 'energia', 'pescas', 'madeira', 'logistica_portuaria', 'nao_aplicavel'],
                description: 'nao_aplicavel si aucun lien réel avec les ressources naturelles.',
              },
              secteur: { type: ['string', 'null'] },
              ville: { type: ['string', 'null'] },
              descricao: { type: ['string', 'null'] },
            },
            required: ['nom_original', 'tipo_entidade', 'setor_recurso_natural', 'secteur', 'ville', 'descricao'],
          },
        },
      },
      required: ['entidades'],
    },
  },
};

function normalizarNome(nome) {
  let n = nome.toLowerCase().trim();
  for (const suf of [' lda', ' sarl', ' sa', ' lda.', ',', '.']) {
    n = n.replaceAll(suf, '');
  }
  return n.trim();
}

async function obterTexto(src, env) {
  if (src.methode === 'scraping_direct') {
    const resp = await fetch(src.url);
    const html = await resp.text();
    const texto = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return texto.slice(0, 8000);
  }

  if (src.methode === 'tavily_extract' || src.methode === 'tavily_search') {
    const endpoint = src.methode === 'tavily_extract' ? 'extract' : 'search';
    const payload = { api_key: env.TAVILY_API_KEY };
    if (endpoint === 'extract') {
      payload.urls = [src.url];
    } else {
      payload.query = src.url;
      payload.max_results = 10;
    }

    const resp = await fetch(`https://api.tavily.com/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    const results = data.results || [];
    const texto = endpoint === 'extract'
      ? results.map(r => r.raw_content || '').join(' ')
      : results.map(r => r.content || '').join(' ');
    return texto.slice(0, 8000);
  }

  return null;
}

function scoreDeSinal(texto) {
  if (!texto || texto.length < 200) return 0;
  let score = 0;
  const marcadoresEmpresa = (texto.match(/\b(Lda|SARL|SA|Ltd|Lda\.|Limitada)\b/g) || []).length;
  score += Math.min(marcadoresEmpresa * 2, 10);
  const nomesProprios = (texto.match(/\b[A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+){1,3}\b/g) || []).length;
  score += Math.min(nomesProprios, 10);
  const numeros = (texto.match(/\d/g) || []).length;
  score += Math.min(Math.floor(numeros / 5), 5);
  if (texto.length > 1500) score += 3;
  return score;
}

async function obterTextoComFallback(src, env) {
  let texto = await obterTexto(src, env);
  let score = scoreDeSinal(texto);

  // Signal trop faible et methode = extraction directe -> on tente une recherche a la place, automatiquement
  if (score < 8 && (src.methode === 'tavily_extract' || src.methode === 'scraping_direct')) {
    const srcFallback = { ...src, methode: 'tavily_search', url: `site:${new URL(src.url.startsWith('http') ? src.url : 'https://' + src.url).hostname} empresa`.replace('site:www.', 'site:') };
    try {
      const textoFallback = await obterTexto(srcFallback, env);
      const scoreFallback = scoreDeSinal(textoFallback);
      if (scoreFallback > score) {
        return { texto: textoFallback, score: scoreFallback, fallbackUsado: true };
      }
    } catch { /* on garde le texte original si le fallback echoue aussi */ }
  }

  return { texto, score, fallbackUsado: false };
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function chamarGroq(texto, env) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: PROMPT_EXTRACTION + texto }],
      temperature: 0,
      response_format: SCHEMA_EXTRACAO,
    }),
  });
  return { status: resp.status, data: await resp.json() };
}

async function extrairComGroq(texto, env) {
  let tentativas = 0;
  let ultimaResposta;

  while (tentativas < 3) {
    ultimaResposta = await chamarGroq(texto, env);
    const { status, data } = ultimaResposta;

    if (status === 200 && data.choices && data.choices[0]) {
      const conteudo = data.choices[0].message.content;
      try {
        const resultado = JSON.parse(conteudo);
        return resultado.entidades || [];
      } catch {
        return [];
      }
    }

    // Rate limit (429) — on lit le temps d'attente suggere par Groq et on patiente vraiment
    if (status === 429) {
      const mensagem = data.error ? data.error.message : '';
      const match = mensagem.match(/try again in ([\d.]+)s/);
      const esperaSegundos = match ? parseFloat(match[1]) : 15;
      await esperar(Math.min(esperaSegundos * 1000 + 500, 60000)); // +0.5s de marge, plafonne a 60s
      tentativas++;
      continue;
    }

    // Autre erreur — pas la peine de reessayer
    break;
  }

  const motivo = ultimaResposta.data.error ? ultimaResposta.data.error.message : JSON.stringify(ultimaResposta.data).slice(0, 200);
  throw new Error(`Groq n'a rien renvoyé d'exploitable après ${tentativas} essai(s) — ${motivo}`);
}

async function gravarEmpresa(emp, src, env) {
  if (!emp.nom_original) return false;
  const nomeNorm = normalizarNome(emp.nom_original);

  const antes = await env.DB.prepare(
    'SELECT id FROM entreprises WHERE nom_normalise = ?'
  ).bind(nomeNorm).first();
  const eraNova = antes === null;

  await env.DB.prepare(
    `INSERT INTO entreprises (nom_normalise, nom_original, secteur, ville, tipo_entidade, setor_recurso_natural)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(nom_normalise) DO NOTHING`
  ).bind(
    nomeNorm, emp.nom_original, emp.secteur || null, emp.ville || null,
    emp.tipo_entidade || null, emp.setor_recurso_natural || null
  ).run();

  const entreprise = await env.DB.prepare(
    'SELECT id FROM entreprises WHERE nom_normalise = ?'
  ).bind(nomeNorm).first();

  await env.DB.prepare(
    `INSERT INTO sources (entreprise_id, source_nom, url, confiance)
     VALUES (?, ?, ?, ?)`
  ).bind(entreprise.id, src.nom, src.url, src.confiance).run();

  return eraNova;
}

// ---------- ÉTAGE 2 : enrichissement (adresse, téléphone, email) ----------

const SCHEMA_ENRIQUECIMENTO = {
  type: 'json_schema',
  json_schema: {
    name: 'contacto_empresa',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        encontrado: { type: 'boolean', description: 'true seulement si les infos ci-dessous ont réellement été trouvées dans le texte' },
        endereco: { type: ['string', 'null'] },
        telefone: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] },
      },
      required: ['encontrado', 'endereco', 'telefone', 'email'],
    },
  },
};

async function enriquecerEmpresa(empresa, env) {
  const query = `"${empresa.nom_original}" contacto endereço telefone Moçambique`;
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: 5 }),
  });
  const data = await resp.json();
  const texto = (data.results || []).map(r => r.content || '').join(' ').slice(0, 6000);
  if (!texto || texto.length < 50) return null;

  const respGroq = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{
        role: 'user',
        content: `Trouve l'adresse, le téléphone et l'email de "${empresa.nom_original}" (entreprise au Mozambique) dans ce texte. N'invente rien — si une info n'est pas explicitement dans le texte, mets null.\n\nTEXTE:\n${texto}`,
      }],
      temperature: 0,
      response_format: SCHEMA_ENRIQUECIMENTO,
    }),
  });
  const dataGroq = await respGroq.json();
  if (!dataGroq.choices || !dataGroq.choices[0]) return null;

  const resultado = JSON.parse(dataGroq.choices[0].message.content);
  if (!resultado.encontrado) return null;
  return resultado;
}

async function rodarTriagem(env) {
  // Le vrai tri se fait ici, sur ce qui a deja ete collecte a l'etage 1 — pas en re-cherchant
  const validadas = await env.DB.prepare(
    `UPDATE entreprises SET validado = 1
     WHERE validado = 0 AND tipo_entidade = 'empresa_privada' AND setor_recurso_natural != 'nao_aplicavel'`
  ).run();
  const rejeitadas = await env.DB.prepare(
    `UPDATE entreprises SET validado = -1
     WHERE validado = 0 AND (tipo_entidade != 'empresa_privada' OR setor_recurso_natural = 'nao_aplicavel')`
  ).run();
  return {
    validadas: validadas.meta.changes || 0,
    rejeitadas: rejeitadas.meta.changes || 0,
  };
}

async function rodarEnriquecimento(env, limite = 5) {
  const triagem = await rodarTriagem(env);

  const pendentes = await env.DB.prepare(
    `SELECT * FROM entreprises WHERE enriquecido = 0 AND validado = 1
     ORDER BY
       CASE WHEN secteur LIKE '%import%' OR secteur LIKE '%export%'
                 OR secteur LIKE '%caju%' OR secteur LIKE '%mineral%'
                 OR secteur LIKE '%agric%' OR secteur LIKE '%madeira%'
                 OR secteur LIKE '%pesca%' THEN 0 ELSE 1 END,
       id
     LIMIT ?`
  ).bind(limite).all();

  let enriquecidas = 0;
  for (const empresa of pendentes.results) {
    try {
      const contacto = await enriquecerEmpresa(empresa, env);
      if (contacto) {
        await env.DB.prepare(
          'UPDATE entreprises SET endereco = ?, telefone = ?, email = ?, enriquecido = 1 WHERE id = ?'
        ).bind(contacto.endereco, contacto.telefone, contacto.email, empresa.id).run();
        enriquecidas++;
      } else {
        await env.DB.prepare('UPDATE entreprises SET enriquecido = 1 WHERE id = ?').bind(empresa.id).run();
      }
    } catch { /* on passe a la suivante, on reessaiera plus tard */ }
  }
  return { triagem, totalTentadas: pendentes.results.length, enriquecidas };
}

// ---------- ÉTAGE 3 : découverte de nouvelles sources (jamais activées automatiquement) ----------

const PAISES_ALVO = ['Moçambique', 'Burundi', 'Tanzânia', 'Zâmbia', 'Ruanda', 'África do Sul'];
const RECURSOS_ALVO = ['minerais', 'café', 'caju', 'madeira', 'pescas', 'algodão', 'gás natural', 'gergelim'];
const FORMULAS_BUSCA = [
  (r, p) => `diretório exportadores ${r} ${p}`,
  (r, p) => `annuaire entreprises ${r} ${p}`,
  (r, p) => `câmara de comércio ${r} ${p} empresas`,
  (r, p) => `business directory ${r} exporters ${p}`,
];

function gerarMatrizDescoberta(limite = 8) {
  const combinacoes = [];
  for (const p of PAISES_ALVO) {
    for (const r of RECURSOS_ALVO) {
      for (const f of FORMULAS_BUSCA) {
        combinacoes.push(f(r, p));
      }
    }
  }
  // On mélange pour ne pas toujours tester les mêmes premiers, et on limite par appel
  for (let i = combinacoes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [combinacoes[i], combinacoes[j]] = [combinacoes[j], combinacoes[i]];
  }
  return combinacoes.slice(0, limite);
}

async function descobrirFontes(env) {
  const candidatas = [];
  const requetes = gerarMatrizDescoberta(8);

  for (const query of requetes) {
    try {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: 5 }),
      });
      const data = await resp.json();

      for (const r of (data.results || [])) {
        const dominio = new URL(r.url).hostname.replace('www.', '');
        const score = scoreDeSinal(r.content || '');
        if (score < 5) continue; // trop faible, pas la peine de le proposer

        const existe = await env.DB.prepare(
          'SELECT id FROM sources_config WHERE url = ?'
        ).bind(r.url).first();
        if (existe) continue;

        await env.DB.prepare(
          `INSERT INTO sources_config (nom, methode, url, confiance, frequence_jours, actif, score_dernier_test)
           VALUES (?, 'tavily_extract', ?, 'baixa', 30, 0, ?)`
        ).bind(`candidata_${dominio}_${Date.now()}`, r.url, score).run();

        candidatas.push({ dominio, url: r.url, score });
      }
      await esperar(1000); // pause legere entre requetes Tavily
    } catch { /* on passe a la requete suivante */ }
  }

  return { candidatasPropostas: candidatas.length, detalhes: candidatas };
}

async function renderPainel(env) {
  const totalValidadas = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM entreprises WHERE validado = 1"
  ).first();
  const hoje = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM entreprises WHERE date(cree_le) = date('now')"
  ).first();
  const recentes = await env.DB.prepare(
    "SELECT nom_original, secteur, ville, endereco, telefone, cree_le FROM entreprises WHERE validado = 1 ORDER BY id DESC LIMIT 20"
  ).all();
  const ultimosRuns = await env.DB.prepare(
    "SELECT date_run, source_nom, entreprises_trouvees, entreprises_nouvelles, erreurs FROM runs_log ORDER BY date_run DESC LIMIT 8"
  ).all();
  const candidatas = await env.DB.prepare(
    "SELECT nom, url, score_dernier_test FROM sources_config WHERE actif = 0 ORDER BY score_dernier_test DESC LIMIT 15"
  ).all();

  const linhaEmpresa = e => `<tr>
    <td>${e.nom_original}</td><td>${e.secteur || '—'}</td><td>${e.ville || '—'}</td>
    <td>${e.telefone || e.endereco ? '✅' : '—'}</td><td class="mono">${(e.cree_le || '').slice(0, 10)}</td>
  </tr>`;
  const linhaRun = r => `<tr>
    <td class="mono">${(r.date_run || '').slice(0, 16)}</td><td>${r.entreprises_nouvelles}</td>
    <td>${r.erreurs ? '⚠️' : '✅'}</td>
  </tr>`;
  const linhaCandidata = c => `<tr><td>${c.nom}</td><td class="mono">${c.score_dernier_test ?? '—'}</td></tr>`;

  return `<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Origem — Painel</title>
  <style>
    body{font-family:-apple-system,sans-serif;background:#14161A;color:#EDEDE9;margin:0;padding:16px;}
    h1{font-size:20px;} h2{font-size:15px;color:#C9902F;margin-top:28px;}
    .cards{display:flex;gap:10px;margin:14px 0;}
    .card{background:#1B1E24;border:1px solid #2A2E36;border-radius:12px;padding:14px;flex:1;text-align:center;}
    .card b{font-size:26px;display:block;color:#7A9B76;}
    table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;}
    th,td{padding:6px 8px;text-align:left;border-bottom:1px solid #2A2E36;}
    th{color:#9AA0AC;font-weight:500;}
    .mono{font-family:monospace;font-size:11px;color:#9AA0AC;}
  </style></head><body>
  <h1>🐙 Origem — Painel de coleta</h1>
  <div class="cards">
    <div class="card"><b>${totalValidadas.n}</b>empresas validadas</div>
    <div class="card"><b>${hoje.n}</b>hoje</div>
    <div class="card"><b>${candidatas.results.length}</b>fontes candidatas</div>
  </div>

  <h2>Últimas empresas</h2>
  <table><tr><th>Nome</th><th>Setor</th><th>Cidade</th><th>Contacto</th><th>Data</th></tr>
  ${recentes.results.map(linhaEmpresa).join('')}</table>

  <h2>Últimas execuções</h2>
  <table><tr><th>Quando</th><th>Novas</th><th>Estado</th></tr>
  ${ultimosRuns.results.map(linhaRun).join('')}</table>

  <h2>Fontes candidatas (por ativar)</h2>
  <table><tr><th>Nome</th><th>Score</th></tr>
  ${candidatas.results.map(linhaCandidata).join('') || '<tr><td colspan="2">Nenhuma por enquanto</td></tr>'}</table>
  </body></html>`;
}

async function rodarColeta(env) {
  const agora = new Date().toISOString();

  const resultado = await env.DB.prepare(
    `SELECT id, nom, methode, url, confiance FROM sources_config
     WHERE actif = 1
     AND (derniere_execution IS NULL
          OR julianday('now') - julianday(derniere_execution) >= frequence_jours)`
  ).all();
  const sourcesDues = resultado.results;

  let totalEncontradas = 0;
  let totalNovas = 0;
  const erros = [];
  const avisos = [];

  for (const src of sourcesDues) {
    try {
      const { texto, score, fallbackUsado } = await obterTextoComFallback(src, env);

      if (score < 8) {
        avisos.push(`${src.nom}: signal faible (${score}) même après fallback — méthode probablement à revoir`);
        await env.DB.prepare(
          'UPDATE sources_config SET score_dernier_test = ? WHERE id = ?'
        ).bind(score, src.id).run();
        continue; // on n'envoie pas du bruit a Groq
      }
      if (fallbackUsado) {
        avisos.push(`${src.nom}: fallback tavily_search utilisé avec succès (score ${score})`);
      }

      const empresas = await extrairComGroq(texto, env);
      for (const emp of empresas) {
        const nova = await gravarEmpresa(emp, src, env);
        totalEncontradas++;
        if (nova) totalNovas++;
      }
      await env.DB.prepare(
        'UPDATE sources_config SET derniere_execution = ?, score_dernier_test = ? WHERE id = ?'
      ).bind(agora, score, src.id).run();
      await esperar(25000); // ~2 appels/minute max pour rester sous 8000 tokens/min Groq
    } catch (e) {
      erros.push(`${src.nom}: ${e.message}`);
    }
  }

  await env.DB.prepare(
    `INSERT INTO runs_log (source_nom, entreprises_trouvees, entreprises_nouvelles, erreurs)
     VALUES (?, ?, ?, ?)`
  ).bind(
    sourcesDues.length ? sourcesDues.map(s => s.nom).join(',') : 'nenhuma',
    totalEncontradas,
    totalNovas,
    [...erros, ...avisos].length ? [...erros, ...avisos].join('; ') : null
  ).run();

  return { totalEncontradas, totalNovas, erros, avisos };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(rodarColeta(env));
    ctx.waitUntil(rodarEnriquecimento(env, 10));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.searchParams.get('ver') === 'painel') {
      const html = await renderPainel(env);
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.searchParams.get('etapa') === '2
