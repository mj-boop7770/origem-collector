import json
import re
from workers import WorkerEntrypoint, Response, fetch

PROMPT_EXTRACTION = """Tu es un extracteur de données structurées. Tu reçois un texte brut (extrait d'une page web africaine — annuaire, article, ou fiche entreprise) et tu dois en extraire les entreprises mentionnées, uniquement si l'information est explicitement présente dans le texte.

RÈGLES STRICTES :
- N'invente JAMAIS une information absente du texte. Si un champ n'est pas mentionné, mets null.
- Un nom d'entreprise doit être un nom propre réel (pas "Empresa X" ou un placeholder).
- Ignore les mentions génériques.
- Le champ "secteur" doit être court et normalisé (ex: "caju", "importação/exportação", "logística").
- Réponds UNIQUEMENT en JSON valide, sans texte avant ni après, sans balises markdown.

FORMAT (toujours un tableau, même vide) :
[{"nom_original": "string", "secteur": "string ou null", "ville": "string ou null", "descricao": "string ou null"}]

TEXTE:
"""


def normalizar_nome(nome):
    """cimextur Lda -> cimextur"""
    n = nome.lower().strip()
    for suf in [" lda", " sarl", " sa", " lda.", ",", "."]:
        n = n.replace(suf, "")
    return n.strip()


class Default(WorkerEntrypoint):

    async def scheduled(self, controller, env, ctx):
        ctx.waitUntil(self.rodar_coleta(env))

    async def fetch(self, request):
        # Permet de déclencher manuellement en visitant l'URL du Worker (utile pour tester sans attendre le cron)
        await self.rodar_coleta(self.env)
        return Response("Coleta executada. Verifique runs_log na base D1.")

    async def rodar_coleta(self, env):
        agora = __import__("datetime").datetime.utcnow().isoformat()

        # 1. Lire les sources dues (dernière exécution > frequence_jours, ou jamais exécutée)
        resultado = await env.DB.prepare(
            """SELECT id, nom, methode, url, confiance FROM sources_config
               WHERE actif = 1
               AND (derniere_execution IS NULL
                    OR julianday('now') - julianday(derniere_execution) >= frequence_jours)"""
        ).all()
        sources_dues = resultado.results

        total_encontradas = 0
        total_novas = 0
        erros = []

        for src in sources_dues:
            try:
                texto = await self.obter_texto(src, env)
                if not texto:
                    continue
                empresas = await self.extrair_com_groq(texto, env)
                for emp in empresas:
                    nova = await self.gravar_empresa(emp, src, env)
                    total_encontradas += 1
                    if nova:
                        total_novas += 1

                # Marquer cette source comme exécutée aujourd'hui
                await env.DB.prepare(
                    "UPDATE sources_config SET derniere_execution = ? WHERE id = ?"
                ).bind(agora, src["id"]).run()

            except Exception as e:
                erros.append(f"{src['nom']}: {str(e)}")

        # Log du run
        await env.DB.prepare(
            """INSERT INTO runs_log (source_nom, entreprises_trouvees, entreprises_nouvelles, erreurs)
               VALUES (?, ?, ?, ?)"""
        ).bind(
            ",".join([s["nom"] for s in sources_dues]) if sources_dues else "nenhuma",
            total_encontradas,
            total_novas,
            "; ".join(erros) if erros else None,
        ).run()

    async def obter_texto(self, src, env):
        """Récupère le texte brut selon la méthode configurée pour cette source."""
        if src["methode"] == "scraping_direct":
            resp = await fetch(src["url"])
            html = await resp.text()
            # Nettoyage minimal — retire les balises pour garder le texte
            texto = re.sub(r"<[^>]+>", " ", html)
            texto = re.sub(r"\s+", " ", texto)
            return texto[:8000]  # limite raisonnable pour Groq

        elif src["methode"] in ("tavily_extract", "tavily_search"):
            endpoint = "extract" if src["methode"] == "tavily_extract" else "search"
            payload = {"api_key": env.TAVILY_API_KEY}
            if endpoint == "extract":
                payload["urls"] = [src["url"]]
            else:
                payload["query"] = src["url"]  # pour search, url contient la requête
                payload["include_domains"] = []
                payload["max_results"] = 10

            resp = await fetch(
                f"https://api.tavily.com/{endpoint}",
                {
                    "method": "POST",
                    "headers": {"Content-Type": "application/json"},
                    "body": json.dumps(payload),
                },
            )
            data = json.loads(await resp.text())
            if endpoint == "extract":
                return " ".join([r.get("raw_content", "") for r in data.get("results", [])])[:8000]
            else:
                return " ".join([r.get("content", "") for r in data.get("results", [])])[:8000]

        return None

    async def extrair_com_groq(self, texto, env):
        resp = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {env.GROQ_API_KEY}",
                },
                "body": json.dumps({
                    "model": "llama-3.3-70b-versatile",
                    "messages": [{"role": "user", "content": PROMPT_EXTRACTION + texto}],
                    "temperature": 0,
                }),
            },
        )
        data = json.loads(await resp.text())
        conteudo = data["choices"][0]["message"]["content"]
        conteudo = conteudo.strip().removeprefix("```json").removeprefix("```").removesuffix("```")
        try:
            return json.loads(conteudo)
        except json.JSONDecodeError:
            return []

    async def gravar_empresa(self, emp, src, env):
        nome_original = emp.get("nom_original")
        if not nome_original:
            return False
        nome_norm = normalizar_nome(nome_original)

        antes = await env.DB.prepare(
            "SELECT id FROM entreprises WHERE nom_normalise = ?"
        ).bind(nome_norm).first()
        era_nova = antes is None

        await env.DB.prepare(
            """INSERT INTO entreprises (nom_normalise, nom_original, secteur, ville)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(nom_normalise) DO NOTHING"""
        ).bind(nome_norm, nome_original, emp.get("secteur"), emp.get("ville")).run()

        entreprise = await env.DB.prepare(
            "SELECT id FROM entreprises WHERE nom_normalise = ?"
        ).bind(nome_norm).first()

        await env.DB.prepare(
            """INSERT INTO sources (entreprise_id, source_nom, url, confiance)
               VALUES (?, ?, ?, ?)"""
        ).bind(entreprise["id"], src["nom"], src["url"], src["confiance"]).run()

        return era_nova
      
