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

async function extrairComGroq(texto, env) {
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
  const data = await resp.json();

  if (!data.choices || !data.choices[0]) {
    const motivo = data.error ? data.error.message : JSON.stringify(data).slice(0, 200);
    throw new Error(`Groq n'a rien renvoyé d'exploitable — ${motivo}`);
  }

  const conteudo = data.choices[0].message.content;
  let resultado;
  try {
    resultado = JSON.parse(conteudo);
  } catch {
    return [];
  }

  // Couche 2 : le CODE filtre, pas le prompt — entreprises privées ET liées aux ressources naturelles uniquement
  return (resultado.entidades || []).filter(
    e => e.tipo_entidade === 'empresa_privada' && e.setor_recurso_natural !== 'nao_aplicavel'
  );
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

async function rodarEnriquecimento(env, limite = 5) {
  const pendentes = await env.DB.prepare(
    'SELECT * FROM entreprises WHERE enriquecido = 0 ORDER BY id LIMIT ?'
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
  return { totalTentadas: pendentes.results.length, enriquecidas };
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
    if (url.searchParams.get('etapa') === '2') {
      const resultado = await rodarEnriquecimento(env, 5);
      return new Response(JSON.stringify(resultado, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const resultado = await rodarColeta(env);
    return new Response(JSON.stringify(resultado, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
      
