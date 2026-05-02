import http from "node:http";

const PORT = process.env.PORT || 8112;
const OLLAMA = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.CONCIERGE_MODEL || "deepseek-v4-pro:cloud";

// ─── Shared helpers ─────────────────────────────────────

function compactCatalog(products) {
  return products.map((p) => {
    const city = (p.city || "").toLowerCase();
    let destination = "Assisi";
    if (city.includes("lourdes")) destination = "Lourdes";
    else if (city.includes("krak")) destination = "Kraków";
    else if (city.includes("fatima") || city.includes("fátima")) destination = "Fátima";
    else if (city.includes("guadalupe") || city.includes("guadalajara")) destination = "Guadalupe";
    else if (city.includes("jerusalem")) destination = "Jerusalem";

    return {
      product_id: p.product_id || p.id,
      title: p.title || p.name,
      price_cents: p.price_cents || Math.round((p.price || 0) * 100),
      city: p.city || "",
      country: p.country || "",
      story: (p.story || p.description || "").slice(0, 200),
      sacrament_tags: p.sacrament_tags || p.tags || [],
      materials: p.materials || [],
      inventory_status: p.inventory_status || (p.inStock ? "in_stock" : "out_of_stock"),
      image_url: p.image_url || "",
      shop: p.shop || null,
      shop_id: p.shop_id || null,
      destination,
    };
  });
}

// ─── Existing / endpoint (stateless recommend - unchanged) ──

function buildRecommendPrompt(catalog, intent, context = {}) {
  const budget = context.budget_cents
    ? `\nBudget: $${(context.budget_cents / 100).toFixed(2)} max — penalize products over budget, boost products well under budget`
    : "";
  const occasion = context.occasion ? `\nOccasion: ${context.occasion}` : "";
  const country = context.country ? `\nPreferred country: ${context.country}` : "";

  const compact = compactCatalog(catalog);

  return `You are a Catholic concierge helping pilgrims find meaningful devotional gifts. You understand sacraments, feast days, holy sites, and the spiritual significance of Catholic objects.

## Destination–Occasion Affinities
- **Lourdes** = healing, anointing of the sick, comfort in suffering (Miraculous waters)
- **Jerusalem** = anointing, ordination, wedding (Holy Land, Cana)
- **Kraków** = Divine Mercy, first communion, baptism (St. Faustina)
- **Fátima** = first communion, baptism, wedding (Our Lady's apparition to children)
- **Guadalupe** = baptism, first communion, protection (Patroness of the Americas)
- **Assisi** = confirmation, RCIA, ordination, peace, house blessing (St. Francis)

## Scoring Rules
- Score 1.0+ for a perfect destination + occasion + budget match
- Score 0.7-0.9 for strong partial match
- Score 0.4-0.6 for weak match
- Score 0.1-0.3 for generic "may like"
- **Budget penalty**: deduct 0.2 per $10 over budget; add 0.1 per $10 under budget (max +/- 0.5)

=== PRODUCT CATALOG ===
${JSON.stringify(compact, null, 2)}

=== USER REQUEST ===
"${intent}"${budget}${occasion}${country}

=== YOUR TASK ===
Recommend the ${context.limit || 3} most fitting products from the catalog. For each, explain WHY in one sentence — connect it to the user's intent, the sacrament, the holy site, or the artisan's story.

Return ONLY valid JSON (no markdown, no backticks):
{
  "summary": "One sentence overview of your recommendations",
  "recommendations": [
    {
      "product_id": "...",
      "score": 0.0,
      "why": "One sentence reason this fits"
    }
  ]
}`;
}

async function callOllamaNonStream(messages, temperature = 0.6) {
  const body = JSON.stringify({
    model: MODEL,
    messages,
    stream: false,
    options: { temperature, top_p: 0.9 },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
    const data = await res.json();
    return data.message?.content || "";
  } finally {
    clearTimeout(timeout);
  }
}

function parseResponse(text) {
  const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const match = cleaned.match(/\{[\s\S]*"recommendations"[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch (_) {} }
  return { summary: text.slice(0, 200), recommendations: [], raw: text };
}

function validateAndEnrich(result, catalog) {
  const catalogMap = new Map(catalog.map((p) => [p.product_id, p]));

  const recommendations = (result.recommendations || [])
    .filter((r) => catalogMap.has(r.product_id))
    .map((r) => {
      const product = catalogMap.get(r.product_id);
      return { score: typeof r.score === "number" ? r.score : 0.5, reasons: [r.why || "Matches your request"], product };
    })
    .slice(0, 5);

  if (recommendations.length === 0) {
    const fallback = catalog
      .filter((p) => p.inventory_status !== "out_of_stock")
      .slice(0, 3)
      .map((p) => ({ score: 0.1, reasons: ["General recommendation"], product: p }));
    return { summary: "Here are some devotional items you might like.", recommendations: fallback };
  }

  return {
    summary: result.summary || `Top match: ${recommendations[0].product.title}`,
    recommendations,
  };
}

// ─── Chat endpoint: multi-turn SSE streaming ────────────

const CHAT_SYSTEM_PROMPT = `You are the Pilgrimage Concierge — a wise, warm, and deeply knowledgeable Catholic guide helping pilgrims find devotional gifts from sacred sites around the world.

## Your Persona
- You speak with reverence and warmth. Use words like "pilgrim," "blessed," "sacred," "grace."
- You are conversing in real time — keep responses under 3 paragraphs. Ask gentle questions.
- You know the sacraments intimately: Baptism, First Communion, Confirmation, Wedding, Ordination, Anointing of the Sick.
- You know the liturgical calendar: Advent, Christmas, Lent, Easter, Ordinary Time, feast days.
- You know these holy sites: Assisi (St. Francis, peace), Lourdes (healing waters), Kraków (Divine Mercy), Fátima (Our Lady's apparition), Guadalupe (miraculous tilma), Jerusalem (Holy City).

## Your Approach
1. **Greet warmly** — welcome the pilgrim. If they mention an occasion, acknowledge its spiritual significance.
2. **Draw out their story** — ask one gentle question if you need more context (who is this for? what draws them to this particular site or sacrament?).
3. **Recommend thoughtfully** — when you have enough context, suggest specific items from the catalog. Explain WHY each item connects to their intention, the holy site, or the artisan's story.
4. **Never fabricate products** — only recommend items from the provided catalog. If nothing fits perfectly, say so honestly and suggest the closest match.
5. **Close with a blessing** — end each recommendation with a short prayer or blessing related to the occasion.

## Response Format
- Write naturally. Do NOT output JSON or structured data — just have a conversation.
- When you want to recommend products, mention them by name naturally: "I believe the Olive Wood Tau Cross from Assisi would be perfect..."
- The system will automatically display product cards when you mention specific products by name.`;

function buildChatMessages(context, catalog) {
  const catalogText = compactCatalog(catalog)
    .map((p) => `- ${p.title} (${p.product_id}) — $${(p.price_cents / 100).toFixed(2)} from ${p.city}, ${p.country}. Tags: ${(p.sacrament_tags || []).join(", ")}. ${p.story}`)
    .join("\n");

  const systemMsg = CHAT_SYSTEM_PROMPT + "\n\n=== AVAILABLE PRODUCTS ===\n" + catalogText;

  const messages = [{ role: "system", content: systemMsg }];

  // Add conversation history (last 10 turns)
  if (context && context.length > 0) {
    const recentContext = context.slice(-20); // last 10 exchanges
    for (const m of recentContext) {
      messages.push({ role: m.role, content: m.content });
    }
  }

  return messages;
}

async function* streamOllama(messages) {
  const body = JSON.stringify({
    model: MODEL,
    messages,
    stream: true,
    options: { temperature: 0.7, top_p: 0.9 },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Ollama ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            yield { type: "text", content: data.message.content };
          }
          if (data.done) {
            yield { type: "done" };
          }
        } catch {}
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer);
        if (data.message?.content) {
          yield { type: "text", content: data.message.content };
        }
      } catch {}
    }
  } finally {
    clearTimeout(timeout);
  }
}

function sse(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ─── Determine if products should be shown ──────────────

function shouldShowProducts(fullResponse, context, occasion, userMessage) {
  // Always show if there's an occasion (gift-seeking intent)
  if (occasion && occasion !== "just_browsing") return true;

  // Explicit ask for recommendations
  const userTexts = [
    userMessage?.toLowerCase() || "",
    context?.[context.length - 1]?.content?.toLowerCase() || "",
  ];
  const explicitAsk = /recommend|suggest|show me|what do you have|looking for|need|want|buy|gift|present|purchase|find|help|something/i;
  if (userTexts.some(t => explicitAsk.test(t))) return true;

  // Show if the assistant mentioned specific products by name or by destination
  const productMentions = fullResponse.match(/\b(?:Olive Wood|Tau Cross|San Damiano|Rosary|Icon|Scapular|Prayer Card|Holy Water|Statue|Medal|Anointing Oil|Wall Pendant|Peace Prayer|Divine Mercy|Fátima|Guadalupe|Lourdes|Assisi|Jerusalem|Kraków)\b/gi);
  if (productMentions && productMentions.length >= 1) return true;

  // Show if the response is long-ish (meaningful recommendation)
  if (fullResponse.length > 300) return true;

  return false;
}

// ─── Extract matching products from assistant response ──

function extractMatchingProducts(fullResponse, catalog) {
  const compact = compactCatalog(catalog);
  const respLower = fullResponse.toLowerCase();
  const matches = [];

  for (const p of compact) {
    const title = p.title.toLowerCase();
    // Check for exact product name mention
    if (respLower.includes(title)) {
      matches.push({ ...p, _matchQuality: "exact" });
      continue;
    }
    // Check significant words from title (skip short/common words)
    const titleWords = title.split(/\s+/).filter(w => w.length > 4 && !/rosary|cross|icon|medal|card|water|oil|set/i.test(w));
    if (titleWords.length === 0) continue;
    const matchCount = titleWords.filter(w => respLower.includes(w)).length;
    const matchRatio = matchCount / titleWords.length;
    if (matchRatio >= 0.6) {
      matches.push({ ...p, _matchQuality: "partial" });
    }
  }

  // Prioritize exact matches, then by price
  matches.sort((a, b) => {
    if (a._matchQuality === "exact" && b._matchQuality !== "exact") return -1;
    if (b._matchQuality === "exact" && a._matchQuality !== "exact") return 1;
    return 0;
  });

  return matches.slice(0, 4); // max 4 product cards
}

// ─── Convert catalog product to frontend Product type ───

function toFrontendProduct(p) {
  const destinations = {
    assisi: "Assisi", lourdes: "Lourdes", krakow: "Kraków",
    fatima: "Fátima", guadalupe: "Guadalupe", jerusalem: "Jerusalem",
  };

  // Use explicit destination or detect from city/country
  let destination = p.destination || "Assisi";
  const city = (p.city || "").toLowerCase();
  if (!p.destination) {
    if (city.includes("lourdes")) destination = "Lourdes";
    else if (city.includes("krak")) destination = "Kraków";
    else if (city.includes("fatima") || city.includes("fátima")) destination = "Fátima";
    else if (city.includes("guadalupe") || city.includes("guadalajara")) destination = "Guadalupe";
    else if (city.includes("jerusalem")) destination = "Jerusalem";
  }

  // Shop name: use shop object from data
  const shopName = p.shop?.name || p.shop_name || (p.city ? `Artisan from ${p.city}` : "Catholic Artisan");

  return {
    id: p.product_id,
    name: p.title,
    shop: p.shop_id || "",
    shopName,
    destination,
    price: (p.price_cents || 0) / 100,
    currency: p.currency || "USD",
    imageUrl: p.image_url || "",
    description: p.story || "",
    provenance: `${p.city || ""}, ${p.country || ""}`.trim().replace(/^, |, $/g, ""),
    materials: p.materials || [],
    blessing: "",
    category: (p.sacrament_tags || [])[0] || "devotional",
    inStock: p.inventory_status !== "out_of_stock",
    leadTime: p.lead_time_days ? `${p.lead_time_days} days` : undefined,
    buyUrl: p.buy_url || "",
  };
}

// ─── HTTP Server ────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ─── POST /chat — multi-turn SSE streaming ────────────
  if (req.method === "POST" && url.pathname === "/chat") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));

    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        const { message, context, occasion, catalog } = payload;

        if (!message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "message required" }));
          return;
        }

        // Set up SSE
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        // Build messages with system prompt + catalog + history + new message
        const userMsg = occasion && occasion !== "just_browsing"
          ? `[Occasion: ${occasion}] ${message}`
          : message;

        const allContext = [...(context || []), { role: "user", content: userMsg }];
        const messages = buildChatMessages(context || [], catalog || []);
        messages.push({ role: "user", content: userMsg });

        // Stream the LLM response
        let fullResponse = "";
        for await (const chunk of streamOllama(messages)) {
          if (chunk.type === "text") {
            fullResponse += chunk.content;
            res.write(sse({ type: "text", content: chunk.content }));
          } else if (chunk.type === "done") {
            break;
          }
        }

        // After streaming, check if we should show products
        if (catalog && catalog.length > 0 && shouldShowProducts(fullResponse, context || [], occasion, message)) {
          const matchedProducts = extractMatchingProducts(fullResponse, catalog);

          if (matchedProducts.length > 0) {
            const frontendProducts = matchedProducts.map(toFrontendProduct);
            res.write(sse({
              type: "product_cards",
              products: frontendProducts,
            }));
          } else {
            // Fallback: run the full recommendation engine
            try {
              const recPrompt = buildRecommendPrompt(catalog, message, {
                occasion: occasion || "",
                limit: 3,
              });
              const recResponse = await callOllamaNonStream([
                { role: "system", content: "You are a Catholic gift recommendation engine. Return only JSON." },
                { role: "user", content: recPrompt },
              ], 0.4);
              const parsed = parseResponse(recResponse);
              const result = validateAndEnrich(parsed, catalog);

              if (result.recommendations.length > 0) {
                const frontendProducts = result.recommendations
                  .map((r) => toFrontendProduct(r.product))
                  .filter(Boolean);
                if (frontendProducts.length > 0) {
                  res.write(sse({ type: "text", content: `\n\n*${result.summary}*` }));
                  res.write(sse({ type: "product_cards", products: frontendProducts }));
                }
              }
            } catch (err) {
              console.error("[concierge] rec fallback error:", err.message);
            }
          }
        }

        res.write(sse({ type: "done" }));
        res.end();
      } catch (err) {
        console.error("[concierge] chat error:", err.message);
        try {
          res.write(sse({ type: "error", message: err.message }));
          res.write(sse({ type: "done" }));
        } catch {}
        res.end();
      }
    });
    return;
  }

  // ─── POST / — stateless recommend (backward compatible) ──
  if (req.method === "POST" && url.pathname === "/") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));

    req.on("end", async () => {
      try {
        const { catalog, intent, budget_cents, occasion, country, limit } = JSON.parse(body);

        if (!intent || !catalog?.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "intent and catalog required" }));
          return;
        }

        const prompt = buildRecommendPrompt(catalog, intent, { budget_cents, occasion, country, limit: limit || 3 });
        const rawResponse = await callOllamaNonStream([{ role: "user", content: prompt }], 0.6);
        const parsed = parseResponse(rawResponse);
        const result = validateAndEnrich(parsed, catalog);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("[concierge] error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ─── Health check ──────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", model: MODEL }));
    return;
  }

  // ─── 404 ───────────────────────────────────────────────
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`[concierge] PI-powered Catholic concierge on port ${PORT}`);
  console.log(`[concierge] model: ${MODEL}`);
  console.log(`[concierge] endpoints: POST / (recommend), POST /chat (streaming)`);
});
