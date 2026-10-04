import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { enforceRateLimit } from '@/lib/rate-limit'

/**
 * POST /api/dashboard/assistant
 *
 * Assistant IA du vigneron (texte/voix). OpenAI gpt-4o-mini + function calling.
 * - Outils de LECTURE : exécutés ici, protégés par RLS.
 * - Outils de PROPOSITION (devis, facture, contact, tâche) : JAMAIS exécutés
 *   côté serveur — renvoyés au front qui affiche une carte de confirmation.
 *   L'exécution passe ensuite par les routes API existantes (validation Zod).
 *
 * Env requise : OPENAI_API_KEY
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_contacts',
      description: 'Recherche des contacts CRM par nom, entreprise ou email',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Nom ou partie du nom' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_products',
      description: 'Recherche des produits (cuvées) par nom, avec prix HT, TVA et stock',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Nom du produit ou cuvée (vide = tous)' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_unpaid_invoices',
      description: 'Liste les factures impayées (montant, client, échéance, retard)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_agenda',
      description: 'Les prochains événements agenda (dégustations, RDV...)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_sales',
      description: 'Les dernières ventes de bouteilles (sorties de stock)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_quote',
      description:
        'Propose un DEVIS (B2B) à faire confirmer par le vigneron. Résous d\'abord contact et produits via search_contacts/search_products pour avoir les vrais IDs et prix.',
      parameters: {
        type: 'object',
        properties: {
          contact_id: { type: 'string' },
          contact_name: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string' },
                product_name: { type: 'string' },
                quantity: { type: 'number' },
                unit_price_ht: { type: 'number' },
                tva_rate: { type: 'number' },
              },
              required: ['product_id', 'product_name', 'quantity', 'unit_price_ht', 'tva_rate'],
            },
          },
          notes: { type: 'string' },
        },
        required: ['contact_id', 'contact_name', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_invoice',
      description:
        'Propose une FACTURE directe à confirmer. sale_mode: "sur_place" (vente au caveau, payée immédiatement, stock déduit) ou "a_distance" (à encaisser puis expédier).',
      parameters: {
        type: 'object',
        properties: {
          contact_id: { type: 'string' },
          contact_name: { type: 'string' },
          sale_mode: { type: 'string', enum: ['sur_place', 'a_distance'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string' },
                product_name: { type: 'string' },
                quantity: { type: 'number' },
                unit_price_ht: { type: 'number' },
                tva_rate: { type: 'number' },
              },
              required: ['product_id', 'product_name', 'quantity', 'unit_price_ht', 'tva_rate'],
            },
          },
        },
        required: ['contact_id', 'contact_name', 'sale_mode', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_contact',
      description: 'Propose la création d\'un contact CRM à confirmer',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          company: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_task',
      description: 'Propose la création d\'une tâche à confirmer',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          due_date: { type: 'string', description: 'YYYY-MM-DD' },
          priority: { type: 'string', enum: ['basse', 'normale', 'haute'] },
        },
        required: ['title'],
      },
    },
  },
]

const SYSTEM_PROMPT = `Tu es l'assistant d'un vigneron champenois sur son dashboard de gestion.
Tu réponds en français, bref et concret. Date du jour : ${new Date().toLocaleDateString('fr-FR')}.
Pour créer un devis/facture : 1) search_contacts pour trouver le client (si plusieurs correspondances, demande lequel), 2) search_products pour les produits demandés (utilise leur vrai prix HT et TVA), 3) appelle propose_quote ou propose_invoice. Ne JAMAIS inventer d'ID ni de prix.
Si le client dit "vente au caveau" ou "il est là" → facture sur_place. Si "à envoyer/expédier" → facture a_distance. Si client professionnel qui veut un devis → propose_quote.
Après un propose_*, dis simplement que tu attends sa confirmation.
Pour les questions (stock, impayés, agenda, ventes), utilise les outils de lecture et fais une réponse claire.`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool(supabase: any, name: string, args: any) {
  switch (name) {
    case 'search_contacts': {
      const { data } = await supabase
        .from('contacts')
        .select('id, name, company, email, type, status')
        // Ne jamais proposer un contact archivé dans un nouveau document.
        .is('archived_at', null)
        .or(`name.ilike.%${(args.query ?? '').replace(/[%,]/g, '')}%,company.ilike.%${(args.query ?? '').replace(/[%,]/g, '')}%`)
        .limit(8)
      return data ?? []
    }
    case 'search_products': {
      let q = supabase
        .from('products')
        .select('id, name, cuvee, millesime, price_ht, tva_rate, stock_current')
        .limit(15)
      if (args.query) q = q.or(`name.ilike.%${args.query.replace(/[%,]/g, '')}%,cuvee.ilike.%${args.query.replace(/[%,]/g, '')}%`)
      const { data } = await q
      return data ?? []
    }
    case 'get_unpaid_invoices': {
      const { data } = await supabase
        .from('invoices')
        .select('invoice_number, amount, due_date, status, contacts(name)')
        .in('status', ['pending', 'overdue'])
        .order('due_date')
        .limit(20)
      return data ?? []
    }
    case 'get_agenda': {
      const { data } = await supabase
        .from('calendar_events')
        .select('title, type, start_at, location')
        .gte('start_at', new Date().toISOString())
        .order('start_at')
        .limit(10)
      return data ?? []
    }
    case 'get_recent_sales': {
      const { data } = await supabase
        .from('stock_movements')
        .select('quantity, reason, created_at, products(name, cuvee)')
        .eq('type', 'sortie')
        .order('created_at', { ascending: false })
        .limit(15)
      return data ?? []
    }
    default:
      return { error: 'Outil inconnu' }
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Chaque requête déclenche jusqu'à 5 tours d'appels GPT (boucle d'outils
  // ci-dessous), tous facturés à l'agence. Sans plafond, un client authentifié
  // peut marteler la route et faire exploser la note OpenAI.
  const limited = enforceRateLimit(`assistant:${user.id}`, 20, 60_000)
  if (limited) return limited

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'OPENAI_API_KEY non configurée dans .env.local' },
      { status: 500 }
    )
  }

  const body = await request.json().catch(() => null)
  const userMessages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : []
  if (userMessages.length === 0) {
    return NextResponse.json({ error: 'messages requis' }, { status: 400 })
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...userMessages.slice(-12),
  ]

  // Boucle d'outils (max 5 tours)
  for (let turn = 0; turn < 5; turn++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages,
        tools: TOOLS,
      }),
    })

    if (!res.ok) {
      const detail = await res.text()
      return NextResponse.json(
        { error: 'Erreur OpenAI', details: detail.slice(0, 300) },
        { status: 502 }
      )
    }

    const json = await res.json()
    const msg = json.choices?.[0]?.message
    if (!msg) return NextResponse.json({ error: 'Réponse OpenAI vide' }, { status: 502 })

    // Pas d'appel d'outil → réponse finale
    if (!msg.tool_calls?.length) {
      return NextResponse.json({ reply: msg.content ?? '…' })
    }

    // Proposition d'action → on renvoie au front pour confirmation
    const proposeCall = msg.tool_calls.find((tc: { function: { name: string } }) =>
      tc.function.name.startsWith('propose_')
    )
    if (proposeCall) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(proposeCall.function.arguments)
      } catch {
        return NextResponse.json({ reply: 'Je n\'ai pas réussi à structurer la demande, reformule ?' })
      }
      return NextResponse.json({
        reply:
          msg.content ??
          'Voici ce que je te propose — confirme pour que je le crée.',
        proposal: {
          type: proposeCall.function.name.replace('propose_', ''),
          data: args,
        },
      })
    }

    // Outils de lecture → exécuter et continuer la boucle
    messages.push(msg)
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments)
      } catch {
        /* args vides */
      }
      const result = await runTool(supabase, tc.function.name, args)
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 6000),
      })
    }
  }

  return NextResponse.json({
    reply: 'Je n\'ai pas réussi à aboutir — reformule ta demande plus simplement ?',
  })
}
