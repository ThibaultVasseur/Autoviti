import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { enforceRateLimit } from '@/lib/rate-limit'

/**
 * POST /api/dashboard/expenses/analyze
 *
 * Analyse un ticket de caisse (photo ou PDF) via GPT-4o Vision et renvoie
 * les champs pré-remplis (montant, TVA, date, commerçant, catégorie).
 * N'enregistre RIEN : le vigneron vérifie puis valide via POST /expenses.
 *
 * Body : FormData { file: File }
 * Env requise : OPENAI_API_KEY
 */

export const maxDuration = 60

const CATEGORIES = [
  'carburant',
  'repas',
  'fournitures',
  'entretien',
  'deplacement',
  'materiel',
  'formation',
  'autre',
] as const

const PROMPT = `Tu analyses un ticket de caisse ou une facture d'achat pour un domaine viticole français.
Renvoie UNIQUEMENT un objet JSON strict, sans texte autour, avec ces clés :
{
  "merchant": "nom du commerçant (string, null si illisible)",
  "expense_date": "date au format YYYY-MM-DD (null si absente)",
  "amount_ttc": nombre (total TTC payé, obligatoire),
  "amount_tva": nombre ou null (montant de TVA),
  "category": une valeur parmi ${CATEGORIES.join(', ')},
  "payment_method": "carte" | "especes" | "virement" | "cheque" | "autre" | null,
  "summary": "résumé court en français de ce qui a été acheté"
}
Règles de catégorie : essence/gazole/station -> carburant ; restaurant/bar/traiteur -> repas ;
papeterie/bureau/emballages -> fournitures ; réparation/pièces/garage -> entretien ;
péage/train/hôtel/parking -> deplacement ; outils/machines/équipement -> materiel ;
stage/formation -> formation ; sinon autre.
Si le montant total est illisible, mets amount_ttc à 0.`

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // OCR GPT-4o Vision : coûteux par appel. Un ticket s'analyse un par un, donc
  // 10/min par vigneron couvre l'usage réel tout en bloquant l'abus.
  const limited = enforceRateLimit(`expense-ocr:${user.id}`, 10, 60_000)
  if (limited) return limited

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'OPENAI_API_KEY non configurée — saisis le ticket manuellement' },
      { status: 500 }
    )
  }

  const formData = await request.formData().catch(() => null)
  const file = formData?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Fichier manquant' }, { status: 400 })
  }

  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'Fichier trop lourd (max 10 Mo)' }, { status: 400 })
  }

  const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  if (!allowedTypes.has(file.type)) {
    return NextResponse.json(
      { error: 'Format non pris en charge : envoie une image JPEG, PNG, WebP ou un PDF' },
      { status: 400 }
    )
  }

  const isPdf = file.type === 'application/pdf'
  const buffer = Buffer.from(await file.arrayBuffer())
  const base64 = buffer.toString('base64')

  // GPT-4o accepte les images ; pour les PDF on tente aussi (documents simples)
  const mime = isPdf ? 'application/pdf' : file.type || 'image/jpeg'

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              isPdf
                ? {
                    type: 'file',
                    file: { filename: file.name, file_data: `data:${mime};base64,${base64}` },
                  }
                : {
                    type: 'image_url',
                    image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' },
                  },
            ],
          },
        ],
      }),
    })

    if (!res.ok) {
      const detail = await res.text()
      return NextResponse.json(
        {
          error: "L'analyse automatique a échoué — complète les champs à la main",
          details: detail.slice(0, 200),
        },
        { status: 502 }
      )
    }

    const json = await res.json()
    const content = json.choices?.[0]?.message?.content
    if (!content) {
      return NextResponse.json(
        { error: 'Ticket illisible — saisis les montants manuellement' },
        { status: 422 }
      )
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(content)
    } catch {
      return NextResponse.json(
        { error: 'Réponse IA inexploitable — saisis les montants manuellement' },
        { status: 422 }
      )
    }

    // Normalisation
    const category = CATEGORIES.includes(parsed.category as (typeof CATEGORIES)[number])
      ? (parsed.category as string)
      : 'autre'

    return NextResponse.json({
      merchant: (parsed.merchant as string) ?? null,
      expense_date: (parsed.expense_date as string) ?? null,
      amount_ttc: Number(parsed.amount_ttc) || 0,
      amount_tva: parsed.amount_tva != null ? Number(parsed.amount_tva) : null,
      category,
      payment_method: (parsed.payment_method as string) ?? null,
      summary: (parsed.summary as string) ?? '',
      ocr_raw: parsed,
    })
  } catch (err) {
    return NextResponse.json(
      {
        error: "Impossible d'analyser le ticket",
        details: err instanceof Error ? err.message : 'Unknown',
      },
      { status: 502 }
    )
  }
}
