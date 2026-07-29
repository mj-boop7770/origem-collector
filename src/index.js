const PROMPT_EXTRACTION = `Tu es un extracteur de données structurées. Tu reçois un texte brut (extrait d'une page web africaine — annuaire, article, ou fiche entreprise) et tu dois en extraire les entreprises mentionnées, uniquement si l'information est explicitement présente dans le texte.

RÈGLES STRICTES :
- N'invente JAMAIS une information absente du texte. Si un champ n'est pas mentionné, mets null.
- Un nom d'entreprise doit être un nom propre réel (pas "Empresa X" ou un placeholder).
- Ignore les mentions génériques.
- Le champ "secteur" doit être court et normalisé (ex: "caju", "importação/exportação", "logística").
- Réponds UNIQUEMENT en JSON valide, sans texte avant ni après, sans balises markdown.

FORMAT (toujours un tableau, même vide) :
[{"nom_original": "string", "secteur": "string ou null", "ville": "string ou null", "descricao": "string ou null"}]

TEXTE:
`;

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

async function extrairComGroq(texto, env) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: PROMPT_EXTRACTION + texto }],
      temperature: 0,
    }),
  });
  const data = await resp.json();
  let conteudo = data.choices[0].message.content.trim();
  conteudo = conteudo.replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(conteudo);
  } catch {
    return [];
  }
}

async function gravarEmpresa(emp, src, env) {
  if (!emp.nom_original) return false;
  const nomeNorm = normalizarNome(emp.nom_original);

  const antes = await env.DB.prepare(
    'SELECT id FROM entreprises WHERE nom_normalise = ?'
  ).bind(nomeNorm).first();
  const eraNova = antes === null;

  await env.DB.prepare(
    `INSERT INTO entreprises (nom_normalise, nom_original, secteur, ville)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(nom_normalise) DO NOTHING`
  ).bind(nomeNorm, emp.nom_original, emp.secteur || null, emp.ville || null).run();

  const entreprise = await env.DB.prepare(
    'SELECT id FROM entreprises WHERE nom_normalise = ?'
  ).bind(nomeNorm).first();

  await env.DB.prepare(
    `INSERT INTO sources (entreprise_id, source_nom, url, confiance)
     VALUES (?, ?, ?, ?)`
  ).bind(entreprise.id, src.nom, src.url, src.confiance).run();

  return eraNova;
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

  for (const src of sourcesDues) {
    try {
      const texto = await obterTexto(src, env);
      if (!texto) continue;
      const empresas = await extrairComGroq(texto, env);
      for (const emp of empresas) {
        const nova = await gravarEmpresa(emp, src, env);
        totalEncontradas++;
        if (nova) totalNovas++;
      }
      await env.DB.prepare(
        'UPDATE sources_config SET derniere_execution = ? WHERE id = ?'
      ).bind(agora, src.id).run();
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
    erros.length ? erros.join('; ') : null
  ).run();

  return { totalEncontradas, totalNovas, erros };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(rodarColeta(env));
  },
  async fetch(request, env, ctx) {
    const resultado = await rodarColeta(env);
    return new Response(JSON.stringify(resultado, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
