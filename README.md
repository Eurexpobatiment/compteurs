# Relevés compteurs – Eurexpo

Application web (GitHub Pages) de saisie des relevés mensuels de compteurs (eau, électricité, gaz, fioul) par Dalkia, avec contrôles, synthèse eau, historique et devis de refacturation des consommations.

- Données : Google Sheet « Relevés compteurs Eurexpo », lu et écrit via l'API Apps Script du projet « Relevés compteurs Eurexpo » (`doPost`, même URL `/exec` que l'appli web).
- Devis : PDF et Excel générés par Apps Script et téléchargés sur l'appareil (rien n'est enregistré dans Drive).
- Après une modification de l'interface dans Apps Script (`Index.html`), reporter le changement dans `index.html` ici.
