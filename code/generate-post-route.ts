import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requirePlan } from '@/lib/plan-guard'
import { enforceRateLimit } from '@/lib/rate-limit'

/**
 * POST /api/dashboard/campaigns/generate-post
 *
 * Rédige un brouillon de post réseaux sociaux à partir d'un brief court.
 * Le vigneron reste maître : le texte revient éditable, rien n'est publié ici.
 *
 * Env requise : OPENAI_API_KEY (déjà utilisée par l'assistant du dashboard).
 */
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const guard = await requirePlan(supabase, user.id, '/api/dashboard/campaigns')
  if (!guard.allowed) return guard.response!

  // Génération de texte via OpenAI, facturée à l'agence : on plafonne pour
  // qu'un client ne puisse pas enchaîner les générations en boucle.
  const limited = enforceRateLimit(`generate-post:${user.id}`, 10, 60_000)
  if (limited) return limited

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY non configurée' }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const brief = typeof body?.brief === 'string' ? body.brief.trim() : ''
  const platforms: string[] = Array.isArray(body?.platforms) ? body.platforms : []
  if (!brief) {
    return NextResponse.json({ error: 'brief requis' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('users')
    .select('domaine, company_name')
    .eq('id', user.id)
    .single()

  const domaine = profile?.domaine || profile?.company_name || 'notre domaine'

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content:
            `Tu rédiges des posts réseaux sociaux pour "${domaine}", un domaine viticole en Champagne. ` +
            `Ton chaleureux, professionnel, jamais ampoulé. Pas de markdown. ` +
            (platforms.length
              ? `Le texte sera publié tel quel sur : ${platforms.join(', ')} — reste assez générique pour convenir à tous ces réseaux (pas de mention spécifique à un seul).`
              : '') +
            ` 2 à 4 émojis pertinents maximum, quelques hashtags pertinents en fin de texte (3 à 5), pas de lien (le vigneron l'ajoutera).`,
        },
        { role: 'user', content: brief },
      ],
    }),
  })

  if (!res.ok) {
    const detail = await res.text()
    return NextResponse.json({ error: 'Erreur OpenAI', details: detail.slice(0, 300) }, { status: 502 })
  }

  const json = await res.json()
  const content = json.choices?.[0]?.message?.content
  if (!content) return NextResponse.json({ error: 'Réponse OpenAI vide' }, { status: 502 })

  return NextResponse.json({ content })
}
