# Relevés compteurs – Eurexpo

Application web (GitHub Pages) de saisie des relevés mensuels de compteurs (eau, électricité, gaz, fioul) par Dalkia et les SSIAP, avec contrôles, synthèse eau, historique et devis de refacturation des consommations.

- Données : **Firebase** (projet `equipe-batiment`, collections `CptCompteurs` et `CptConfig`) depuis le 6 nov. 2026. Calculs dans `metier.js`.
- Fichiers PDF / Excel (devis, export des index) : fabriqués par le script Google « Relevés compteurs Eurexpo » (`fbDevisFichiers`, `fbExportIndex`) à partir des données envoyées, puis téléchargés (rien dans Drive).
- Référentiel des compteurs : onglet Compteurs du classeur, recopié avec `copierVersFirebase`.
- Détails et fichiers du script : `v2/LISEZMOI-FIREBASE.md`, `v2/Firebase.gs`, `v2/Eau.gs`, `v2/firestore-compteurs.rules`.
