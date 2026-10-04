# Extraits de code

Fichiers copiés tels quels depuis le dépôt privé d'AutoViti : c'est le code qui tourne
en production, sans réécriture pour la vitrine. Ils ne se compilent pas seuls (ils
importent des modules internes comme `@/lib/supabase/server`).

| Fichier | Ce qu'il montre |
|---|---|
| [`assistant-route.ts`](assistant-route.ts) | Boucle de function calling bornée à 5 tours, outils de lecture exécutés sous RLS, actions `propose_*` renvoyées pour confirmation humaine, plafond de coût par utilisateur |
| [`receipt-ocr-route.ts`](receipt-ocr-route.ts) | Extraction structurée depuis une image ou un PDF (GPT-4o Vision, mode JSON), normalisation vers une liste fermée, dégradation vers la saisie manuelle |
| [`generate-post-route.ts`](generate-post-route.ts) | Génération de texte contrôlée par le contexte du client et l'accès par formule, sans publication automatique |
