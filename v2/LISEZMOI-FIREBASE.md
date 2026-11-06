# Relevés compteurs – version Firebase

Même appli que la version actuelle (mêmes onglets, mêmes contrôles, mêmes devis), avec les données dans **Firebase**
(projet `equipe-batiment`, le même que les applis Équipe et Températures) au lieu du Google Sheet :
chargement instantané, consultation et saisie hors connexion (envoi automatique au retour du réseau).

Adresse pendant la transition : https://eurexpobatiment.github.io/compteurs/v2/
L'ancienne version (https://eurexpobatiment.github.io/compteurs/) continue de marcher en parallèle.

Pour Dalkia et les SSIAP, rien ne change : pas de compte, on indique son nom en haut de l'écran.
La toute première saisie sur un appareil demande internet ; ensuite les relevés passent même sans réseau.

## Mise en route (une seule fois)
1. **Console Firebase › equipe-batiment › Authentication › Mode de connexion** : « Anonyme » doit être activé (déjà fait pour les Températures).
2. **Firestore Database › Règles** : coller le bloc de `firestore-compteurs.rules` juste avant les deux dernières `}`, puis **Publier**.
3. **Script Google « Relevés compteurs Eurexpo »** (script.google.com) : ajouter un fichier **Firebase** et y coller `Firebase.gs`
   (sans rien changer à Code.gs), enregistrer, puis :
   - exécuter `copierVersFirebase` (copie des 162 compteurs, de tous les relevés, des tarifs, des compteurs facturés et du registre des devis) ;
   - exécuter `installerFirebase` (copie dans Firebase, toutes les 10 minutes, des relevés encore saisis dans l'ancienne version) ;
   - **Déployer › Gérer les déploiements › crayon › Version : Nouvelle version › Déployer** (même adresse : c'est ce qui permet à la
     version Firebase de faire éditer les PDF / Excel).
4. **Script Google de l'appli Consommations** : remplacer le contenu du fichier `Eau.gs` par celui de `Eau.gs` ci-joint, enregistrer,
   puis Déployer › Gérer les déploiements › Nouvelle version. L'onglet Eau lit alors Firebase (et le classeur en secours).

## Fonctionnement
- **Compteurs et relevés** : collection `CptCompteurs`, un document par compteur avec ses relevés mois par mois (champ `r`).
  Une ouverture de l'appli lit ~160 documents (au lieu d'interroger le classeur à chaque écran).
- **Calculs** (consommation, « Index en baisse », « Saut anormal », habituel, synthèse eau, devis) : faits dans l'appli,
  avec exactement les mêmes règles que le script (vérifié sur tout l'historique : mêmes résultats).
- **Référentiel des compteurs** : reste l'onglet **Compteurs** du classeur. Après un ajout ou une modification de compteur,
  relancer `copierVersFirebase` (sans risque : elle ne remplace pas les relevés plus récents saisis dans Firebase).
- **Devis** : tarifs et compteurs facturés dans `CptConfig/devis`, registre et numérotation dans `CptConfig/registre`.
  Le PDF et l'Excel sont toujours fabriqués par le script Google (même mise en page), puis téléchargés : rien dans Drive.
- **Export Excel de tous les index** (onglet Historique) : même fichier, fabriqué par le script à partir des données Firebase.
- **Appli Consommations** : son onglet Eau lit Firebase (résultat gardé 5 minutes).
- **Pendant la transition** : les relevés saisis dans l'ancienne version sont copiés dans Firebase toutes les 10 minutes.
  L'inverse ne se fait pas : l'ancienne version (et les onglets Index / Conso / Synthèse eau du classeur) ne voient pas
  les relevés saisis dans la nouvelle.

## Bascule définitive (quand la version Firebase est validée)
Remplacer l'appli de la racine du dépôt par le contenu de `v2/`, puis exécuter `desinstallerFirebase` dans le script.
Le classeur reste comme archive.
