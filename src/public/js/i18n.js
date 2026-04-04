/**
 * WebSend Internationalization (i18n) Module
 *
 * Simple translation system supporting English and French.
 * Detects browser locale and falls back to English if not French.
 *
 * Usage:
 *   1. Include this script in your HTML
 *   2. Add data-i18n="key" attributes to elements
 *   3. Call i18n.init() to apply translations
 *   4. Use i18n.t('key') for dynamic translations
 */

const i18n = (function() {
    // Translation dictionaries
    const translations = {
        en: {
            // Common
            'app.name': 'WebSend',
            'app.subtitle': 'Secure Photo Transfer',
            'nav.back': '← Back',
            'common.close': 'Close',

            // Index page
            'index.receive': 'Receive',
            'index.receive.hint': 'Show QR code on this device',
            'index.send': 'Send',
            'index.send.hint': 'Scan QR & send photos',
            'index.footer': 'Your photos are encrypted end-to-end.<br>They never pass unencrypted through any server.',
            'index.about': 'About',

            // About modal
            'about.title': 'About WebSend',
            'about.description': 'A secure, end-to-end encrypted photo transfer app designed for environments where data privacy is paramount. Photos never leave your device unencrypted, and only the intended recipient can decrypt them — no middleman, not even the server, ever has access.',
            'about.techStack': 'Tech Stack',
            'about.techStack.frontend': 'Vanilla HTML, CSS, JavaScript (no frameworks)',
            'about.techStack.transport': 'WebRTC peer-to-peer data channels',
            'about.techStack.encryption': 'ECDH key exchange + AES-GCM (Web Crypto API)',
            'about.techStack.signaling': 'Express.js server (SDP relay only)',
            'about.techStack.qr': 'qrcode.js / jsQR',
            'about.techStack.turn': 'coturn (fallback when direct P2P fails)',
            'about.security': 'Security',
            'about.security.1': 'Photos are encrypted before leaving your device',
            'about.security.2': 'The server only relays connection metadata (SDP)',
            'about.security.3': 'Keys are generated fresh for each session',
            'about.security.4': 'Fingerprint verification prevents MITM attacks',
            'about.credits': 'Credits',
            'about.credits.text': 'Built with',
            'about.credits.link': 'Claude Code',
            'about.credits.suffix': '(AI-assisted development).',
            'about.credits.repo': 'Source code on GitHub (AGPLv3)',
            'about.thirdParty': 'Third-Party Libraries',
            'about.thirdParty.note': 'All client-side libraries are vendored directly in the repository (no CDN at runtime). All licenses are compatible with AGPL-3.0.',

            // Send page
            'send.title': 'Send Photos',
            'send.scanSubtitle': 'Scan the QR code from the receiver\'s screen',
            'send.startCamera': 'Start Camera to Scan',
            'send.scanning': 'Scanning...',
            'send.tip': '<strong>Tip:</strong> Point your camera at the QR code on the receiver\'s screen. The QR code contains a security token that cannot be typed manually.',
            'send.connecting': 'Connecting to receiver...',
            'send.establishing': 'Establishing connection...',
            'send.connected': 'Connected!',
            'send.failed': 'Connection failed. Please try again.',
            'send.failedNoTurn': 'No relay (TURN) server is configured. Direct connection may be impossible if both devices are behind restrictive networks. Check the Logs for details.',
            'send.connectedSecure': 'Connected securely!',
            'send.detectingConnection': 'Detecting connection type...',
            'send.howToSend': 'How would you like to send photos?',
            'send.takePhoto': 'Take New Photo',
            'send.choosePhoto': 'Choose Existing Photo',
            'send.capture': '📸',
            'send.backToOptions': '← Back',
            'send.backToScan': '← Back to Scan',
            'send.preview': 'Preview',
            'send.encrypting': 'Encrypting and sending...',
            'send.sendingProgress': 'Sending...',
            'send.sendPhoto': 'Send Photo',
            'send.retake': 'Retake',
            'send.cancel': 'Cancel',
            'send.sentSuccess': 'Photo sent successfully!',
            'send.transferVerified': 'Photo sent and verified!',
            'send.sendAnother': 'Send Another',
            'send.waitingConfirmation': '⏳ Waiting for receiver to confirm...',
            'send.awaitingConfirmation': 'Awaiting confirmation from receiver...',
            'send.checksumMismatch': 'Transfer verification failed — checksums don\'t match. Retry?',
            'send.retryTransfer': 'Retry',
            'send.transferTimeout': 'No confirmation received. The photo may not have arrived. Retry?',
            'send.invalidQR.secret': 'Invalid QR code - missing security token',
            'send.invalidQR.noRoom': 'Invalid QR code. Please scan the QR code from the receiver.',
            'send.invalidQR.secretMissing': 'Invalid QR code - security token missing. Please scan a fresh QR code.',
            'send.flashOff': 'Off',
            'send.flashTorch': 'On',
            'send.flashAuto': 'Auto',
            'send.detectOff': 'Detect',
            'send.detectOn': 'Detect',
            'send.cameraError': 'Could not access camera. Please allow camera access or use manual input.',
            'send.cameraFailed': 'Could not access camera.',
            'send.sendFailed': 'Failed to send photo. Please try again.',
            'send.disconnected': 'Connection lost. Please start over.',
            'send.edit': 'Edit',
            'send.rotate': 'Rotate',
            'send.flip': 'Flip',
            'send.applyBW': 'B&W',
            'send.queueSending': '📤 Sending {n} photo(s) in background…',
            'send.allSent': 'All {n} photos sent!',
            'send.done': '✓',
            'send.gallery': 'Gallery',
            'send.clearAll': 'Clear',
            'send.sendAll': 'Send All ({n})',
            'send.editPhoto': 'Edit',
            'send.noPhotos': 'No photos yet. Take some photos first!',
            'send.galleryEmpty': 'Gallery is empty',

            // Receive page
            'receive.title': 'Receive Photos',
            'receive.scanSubtitle': 'Scan this QR code with your phone',
            'receive.generating': 'Generating secure connection...',
            'receive.waiting': 'Waiting for sender to scan...',
            'receive.connecting': 'Connecting...',
            'receive.connected': 'Connected!',
            'receive.failed': 'Connection failed. Please try again.',
            'receive.failedNoTurn': 'No relay (TURN) server is configured. Direct connection may be impossible if both devices are behind restrictive networks. Check the Logs for details.',
            'receive.connectedWaiting': 'Connected! Waiting for photos...',
            'receive.waitingConfirmation': '⏳ Waiting for sender to confirm...',
            'receive.detectingConnection': 'Detecting connection type...',
            'receive.receivedPhotos': 'Received Photos',
            'receive.photosPlaceholder': 'Waiting for sender to send photos.',
            'receive.downloadPdf': 'Download All as PDF',
            'receive.downloadPdfCount': 'Download All as PDF ({count} image{plural})',
            'receive.generatingPdf': '⏳ Generating PDF...',
            'receive.exportBtn': 'Export All',
            'receive.exportBtnCount': 'Export ({count} image{plural})',
            'receive.selectAll': 'Select All',
            'receive.deselectAll': 'Deselect All',
            'receive.selectionCount': '{selected}/{total} selected',
            'receive.exportTitle': 'Export',
            'receive.exportZip': 'ZIP of all images',
            'receive.exportPdf': 'PDF',
            'receive.exportBW': 'Black & white (document mode)',
            'receive.exportOCR': 'OCR (searchable PDF) — experimental',
            'receive.exportConfirm': 'Export',
            'receive.exportCancel': 'Cancel',
            'receive.comingSoon': '(coming soon)',
            'receive.generatingZip': '⏳ Generating ZIP...',
            'receive.ocrProcessing': '⏳ OCR processing {count} image(s)... allow max 1 min/image',
            'receive.ocrInitializing': '⏳ Loading OCR engine...',
            'receive.ocrTimeout': 'OCR timed out after {minutes} min. You can retry.',
            'receive.ocrFailed': 'OCR failed: {error}. You can retry.',
            'receive.ocrCancel': '❌ Cancel OCR (export plain PDF instead)',
            'receive.ocrCancelledFallback': 'OCR cancelled — exporting plain PDF instead.',
            'receive.crop': '✂️',
            'receive.download': '📥',
            'receive.discard': '🗑️',
            'receive.discardConfirm': 'Remove this photo?',
            'receive.discardYes': '✓ Remove',
            'receive.discardNo': '✗ Cancel',
            'receive.expired': 'Connection expired. Please refresh.',
            'receive.initFailed': 'Failed to initialize. Please refresh.',
            'receive.disconnected': 'Disconnected',
            'receive.qrFailed': 'QR code failed. Share this URL:',

            // Crop modal
            'crop.title': 'Crop Document',
            'crop.instructions': 'Drag the corners to mark the document edges',
            'crop.cancel': 'Cancel',
            'crop.apply': 'Apply Crop',

            // Verification modal
            'verify.title': '🔒 Verify Connection',
            'verify.instruction.sender': 'Read these codes aloud to the receiver. Do they match what they see?',
            'verify.instruction.receiver': 'Read these codes aloud to the sender. Do they match what they see?',
            'verify.senderKey.yours': 'Sender\'s key (yours)',
            'verify.senderKey.theirs': 'Sender\'s key (theirs)',
            'verify.receiverKey.yours': 'Receiver\'s key (yours)',
            'verify.receiverKey.theirs': 'Receiver\'s key (theirs)',
            'verify.warning': '⚠️ If codes don\'t match, someone may be intercepting the connection!',
            'verify.confirm': '✓ Yes, codes match',
            'verify.deny': '✗ No, cancel connection',
            'verify.deniedBySender': 'Connection cancelled by sender - fingerprints did not match.\n\nThis could indicate a security issue. Please try again.',
            'verify.deniedByReceiver': 'Connection cancelled by receiver - fingerprints did not match.\n\nThis could indicate a security issue. Please try again.',
            'verify.selfDenied': 'Connection cancelled.\n\nIf the codes did not match, someone may have been intercepting the connection. Please try again in a secure environment.',

            // Connection types
            'connection.relay': '🔄 {details}',
            'connection.direct': '⚡ {details}',
            'connection.relayDetails': 'Relayed via TURN server',
            'connection.relaySecureDetails': 'Relayed via TURNS server (TLS)',
            'connection.directLocalDetails': 'Direct (local network)',
            'connection.directP2PDetails': 'Direct P2P (via STUN)',
            'connection.verified': '✓ Verified by both parties',

            // Menu / Sidebar
            'menu.logs': 'Logs',
            'menu.closeLogs': 'Close Logs',
            'menu.copyLogs': 'Copy Logs',
            'menu.logsCopied': 'Copied!',
            'menu.about': 'About',
            'menu.language': 'Language',
            'menu.connection': 'Connection',
            'menu.devMode': 'DEV mode enabled',
            'menu.prodMode': 'Production mode',
            'maintenance.banner': '\u26a0\ufe0f Developer instance — expect occasional restarts. Things should work, but if something seems off, it\'s likely being actively worked on.',

            // Disconnection hints
            'receive.disconnectedHint': 'Disconnected. Reload the page or click Back to restart.',
            'receive.reconnecting': 'Reconnecting...',
            'receive.reconnectFailed': 'Reconnection failed. Reload the page to restart.',
            'receive.senderDisconnected': 'Sender disconnected',
            'receive.showQRCode': 'Show QR Code to reconnect',
            'send.disconnectedHint': 'Connection lost. Reload the page or click Back to restart.',
            'send.reconnecting': 'Reconnecting...',
            'send.reconnectFailed': 'Reconnection failed. Reload the page or click Back to restart.',

            // Errors
            'error.noPhotoOrKey': 'No photo or key exchange not complete',
            'error.selectImage': 'Please select an image file'
        },

        fr: {
            // Common
            'app.name': 'WebSend',
            'app.subtitle': 'Transfert de Photos Sécurisé',
            'nav.back': '← Retour',
            'common.close': 'Fermer',

            // Index page
            'index.receive': 'Recevoir',
            'index.receive.hint': 'Afficher le QR code sur cet appareil',
            'index.send': 'Envoyer',
            'index.send.hint': 'Scanner le QR et envoyer des photos',
            'index.footer': 'Vos photos sont chiffrées de bout en bout.<br>Elles ne transitent jamais en clair par aucun serveur.',
            'index.about': 'À propos',

            // About modal
            'about.title': 'À propos de WebSend',
            'about.description': 'Une application de transfert de photos sécurisée, chiffrée de bout en bout, conçue pour les environnements où la confidentialité des données est primordiale. Les photos ne quittent jamais votre appareil sans être chiffrées, et seul le destinataire peut les déchiffrer — aucun intermédiaire, pas même le serveur, n\'y a accès.',
            'about.techStack': 'Technologies',
            'about.techStack.frontend': 'HTML, CSS, JavaScript pur (sans framework)',
            'about.techStack.transport': 'Canaux de données WebRTC pair-à-pair',
            'about.techStack.encryption': 'Échange de clés ECDH + AES-GCM (Web Crypto API)',
            'about.techStack.signaling': 'Serveur Express.js (relais SDP uniquement)',
            'about.techStack.qr': 'qrcode.js / jsQR',
            'about.techStack.turn': 'coturn (relais quand le P2P direct échoue)',
            'about.security': 'Sécurité',
            'about.security.1': 'Les photos sont chiffrées avant de quitter votre appareil',
            'about.security.2': 'Le serveur ne relaie que les métadonnées de connexion (SDP)',
            'about.security.3': 'Les clés sont générées à neuf pour chaque session',
            'about.security.4': 'La vérification d\'empreinte empêche les attaques MITM',
            'about.credits': 'Crédits',
            'about.credits.text': 'Développé avec',
            'about.credits.link': 'Claude Code',
            'about.credits.suffix': '(développement assisté par IA).',
            'about.credits.repo': 'Code source sur GitHub (AGPLv3)',
            'about.thirdParty': 'Bibliothèques tierces',
            'about.thirdParty.note': 'Toutes les bibliothèques côté client sont incluses directement dans le dépôt (pas de CDN à l\'exécution). Toutes les licences sont compatibles avec l\'AGPL-3.0.',

            // Send page
            'send.title': 'Envoyer des Photos',
            'send.scanSubtitle': 'Scannez le QR code affiché sur l\'écran du destinataire',
            'send.startCamera': 'Activer la caméra pour scanner',
            'send.scanning': 'Scan en cours...',
            'send.tip': '<strong>Astuce :</strong> Pointez votre caméra vers le QR code sur l\'écran du destinataire. Le QR code contient un jeton de sécurité qui ne peut pas être saisi manuellement.',
            'send.connecting': 'Connexion au destinataire...',
            'send.establishing': 'Établissement de la connexion...',
            'send.connected': 'Connecté !',
            'send.failed': 'Échec de la connexion. Veuillez réessayer.',
            'send.failedNoTurn': 'Aucun serveur relais (TURN) n\'est configuré. La connexion directe peut être impossible si les deux appareils sont derrière des réseaux restrictifs. Consultez les Logs pour plus de détails.',
            'send.connectedSecure': 'Connecté de manière sécurisée !',
            'send.detectingConnection': 'Détection du type de connexion...',
            'send.howToSend': 'Comment souhaitez-vous envoyer des photos ?',
            'send.takePhoto': 'Prendre une nouvelle photo',
            'send.choosePhoto': 'Choisir une photo existante',
            'send.capture': '📸',
            'send.backToOptions': '← Retour',
            'send.backToScan': '← Retour au scan',
            'send.preview': 'Aperçu',
            'send.encrypting': 'Chiffrement et envoi...',
            'send.sendingProgress': 'Envoi...',
            'send.sendPhoto': 'Envoyer la photo',
            'send.retake': 'Reprendre',
            'send.cancel': 'Annuler',
            'send.sentSuccess': 'Photo envoyée avec succès !',
            'send.transferVerified': 'Photo envoyée et vérifiée !',
            'send.sendAnother': 'Envoyer une autre',
            'send.waitingConfirmation': '⏳ En attente de confirmation du destinataire...',
            'send.awaitingConfirmation': 'En attente de confirmation du destinataire...',
            'send.checksumMismatch': 'Échec de vérification — les sommes de contrôle ne correspondent pas. Réessayer ?',
            'send.retryTransfer': 'Réessayer',
            'send.transferTimeout': 'Aucune confirmation reçue. La photo n\'est peut-être pas arrivée. Réessayer ?',
            'send.invalidQR.secret': 'QR code invalide - jeton de sécurité manquant',
            'send.invalidQR.noRoom': 'QR code invalide. Veuillez scanner le QR code du destinataire.',
            'send.invalidQR.secretMissing': 'QR code invalide - jeton de sécurité manquant. Veuillez scanner un nouveau QR code.',
            'send.flashOff': 'Off',
            'send.flashTorch': 'On',
            'send.flashAuto': 'Auto',
            'send.detectOff': 'Détecter',
            'send.detectOn': 'Détecter',
            'send.cameraError': 'Impossible d\'accéder à la caméra. Veuillez autoriser l\'accès à la caméra.',
            'send.cameraFailed': 'Impossible d\'accéder à la caméra.',
            'send.sendFailed': 'Échec de l\'envoi. Veuillez réessayer.',
            'send.disconnected': 'Connexion perdue. Veuillez recommencer.',
            'send.edit': 'Modifier',
            'send.rotate': 'Tourner',
            'send.flip': 'Miroir',
            'send.applyBW': 'N&B',
            'send.queueSending': '📤 Envoi de {n} photo(s) en arrière-plan…',
            'send.allSent': '{n} photos envoyées !',
            'send.done': '✓',
            'send.gallery': 'Galerie',
            'send.clearAll': 'Vider',
            'send.sendAll': 'Tout envoyer ({n})',
            'send.editPhoto': 'Modifier',
            'send.noPhotos': 'Aucune photo. Prenez des photos d\'abord !',
            'send.galleryEmpty': 'La galerie est vide',

            // Receive page
            'receive.title': 'Recevoir des Photos',
            'receive.scanSubtitle': 'Scannez ce QR code avec votre téléphone',
            'receive.generating': 'Génération de la connexion sécurisée...',
            'receive.waiting': 'En attente du scan...',
            'receive.connecting': 'Connexion...',
            'receive.connected': 'Connecté !',
            'receive.failed': 'Échec de la connexion. Veuillez réessayer.',
            'receive.failedNoTurn': 'Aucun serveur relais (TURN) n\'est configuré. La connexion directe peut être impossible si les deux appareils sont derrière des réseaux restrictifs. Consultez les Logs pour plus de détails.',
            'receive.connectedWaiting': 'Connecté ! En attente des photos...',
            'receive.waitingConfirmation': '⏳ En attente de confirmation de l\'expéditeur...',
            'receive.detectingConnection': 'Détection du type de connexion...',
            'receive.receivedPhotos': 'Photos reçues',
            'receive.photosPlaceholder': 'En attente d\'envoi des photos par l\'expéditeur.',
            'receive.downloadPdf': 'Télécharger tout en PDF',
            'receive.downloadPdfCount': 'Télécharger tout en PDF ({count} image{plural})',
            'receive.generatingPdf': '⏳ Génération du PDF...',
            'receive.exportBtn': 'Exporter tout',
            'receive.exportBtnCount': 'Exporter ({count} image{plural})',
            'receive.selectAll': 'Tout sélectionner',
            'receive.deselectAll': 'Tout désélectionner',
            'receive.selectionCount': '{selected} / {total} sélectionnée(s)',
            'receive.exportTitle': 'Exporter',
            'receive.exportZip': 'ZIP de toutes les images',
            'receive.exportPdf': 'PDF',
            'receive.exportBW': 'Noir et blanc (mode document)',
            'receive.exportOCR': 'OCR (PDF avec recherche) — expérimental',
            'receive.exportConfirm': 'Exporter',
            'receive.exportCancel': 'Annuler',
            'receive.comingSoon': '(bientôt)',
            'receive.generatingZip': '⏳ Génération du ZIP...',
            'receive.ocrProcessing': '⏳ OCR en cours pour {count} image(s)... comptez max 1 min/image',
            'receive.ocrInitializing': '⏳ Chargement du moteur OCR...',
            'receive.ocrTimeout': 'L\'OCR a expiré après {minutes} min. Vous pouvez réessayer.',
            'receive.ocrFailed': 'L\'OCR a échoué : {error}. Vous pouvez réessayer.',
            'receive.ocrCancel': '❌ Annuler l\'OCR (exporter en PDF simple)',
            'receive.ocrCancelledFallback': 'OCR annulé — export en PDF simple à la place.',
            'receive.crop': '✂️',
            'receive.download': '📥',
            'receive.discard': '🗑️',
            'receive.discardConfirm': 'Supprimer cette photo ?',
            'receive.discardYes': '✓ Supprimer',
            'receive.discardNo': '✗ Annuler',
            'receive.expired': 'Connexion expirée. Veuillez actualiser.',
            'receive.initFailed': 'Échec de l\'initialisation. Veuillez actualiser.',
            'receive.disconnected': 'Déconnecté',
            'receive.qrFailed': 'Échec du QR code. Partagez cette URL :',

            // Crop modal
            'crop.title': 'Recadrer le document',
            'crop.instructions': 'Faites glisser les coins pour marquer les bords du document',
            'crop.cancel': 'Annuler',
            'crop.apply': 'Appliquer',

            // Verification modal
            'verify.title': '🔒 Vérifier la connexion',
            'verify.instruction.sender': 'Lisez ces codes à voix haute au destinataire. Correspondent-ils à ce qu\'il voit ?',
            'verify.instruction.receiver': 'Lisez ces codes à voix haute à l\'expéditeur. Correspondent-ils à ce qu\'il voit ?',
            'verify.senderKey.yours': 'Clé de l\'expéditeur (la vôtre)',
            'verify.senderKey.theirs': 'Clé de l\'expéditeur (la leur)',
            'verify.receiverKey.yours': 'Clé du destinataire (la vôtre)',
            'verify.receiverKey.theirs': 'Clé du destinataire (la leur)',
            'verify.warning': '⚠️ Si les codes ne correspondent pas, quelqu\'un peut intercepter la connexion !',
            'verify.confirm': '✓ Oui, les codes correspondent',
            'verify.deny': '✗ Non, annuler la connexion',
            'verify.deniedBySender': 'Connexion annulée par l\'expéditeur - les empreintes ne correspondaient pas.\n\nCela pourrait indiquer un problème de sécurité. Veuillez réessayer.',
            'verify.deniedByReceiver': 'Connexion annulée par le destinataire - les empreintes ne correspondaient pas.\n\nCela pourrait indiquer un problème de sécurité. Veuillez réessayer.',
            'verify.selfDenied': 'Connexion annulée.\n\nSi les codes ne correspondaient pas, quelqu\'un a peut-être intercepté la connexion. Veuillez réessayer dans un environnement sécurisé.',

            // Connection types
            'connection.relay': '🔄 {details}',
            'connection.direct': '⚡ {details}',
            'connection.relayDetails': 'Relayé via le serveur TURN',
            'connection.relaySecureDetails': 'Relayé via le serveur TURNS (TLS)',
            'connection.directLocalDetails': 'Direct (réseau local)',
            'connection.directP2PDetails': 'Direct P2P (via STUN)',
            'connection.verified': '✓ Vérifié par les deux parties',

            // Menu / Sidebar
            'menu.logs': 'Journaux',
            'menu.closeLogs': 'Fermer les journaux',
            'menu.copyLogs': 'Copier les journaux',
            'menu.logsCopied': 'Copié !',
            'menu.about': 'À propos',
            'menu.language': 'Langue',
            'menu.connection': 'Connexion',
            'menu.devMode': 'Mode DEV activé',
            'menu.prodMode': 'Mode production',
            'maintenance.banner': '\u26a0\ufe0f Instance de développement — des redémarrages sont possibles. Tout devrait fonctionner, mais en cas de souci, c\'est probablement en cours de modification.',

            // Disconnection hints
            'receive.disconnectedHint': 'Déconnecté. Rechargez la page ou cliquez sur Retour pour redémarrer.',
            'receive.reconnecting': 'Reconnexion en cours...',
            'receive.reconnectFailed': 'Reconnexion échouée. Rechargez la page pour recommencer.',
            'receive.senderDisconnected': 'Expéditeur déconnecté',
            'receive.showQRCode': 'Afficher le QR Code pour reconnecter',
            'send.disconnectedHint': 'Connexion perdue. Rechargez la page ou cliquez sur Retour pour redémarrer.',
            'send.reconnecting': 'Reconnexion en cours...',
            'send.reconnectFailed': 'Reconnexion échouée. Rechargez la page ou cliquez sur Retour pour recommencer.',

            // Errors
            'error.noPhotoOrKey': 'Pas de photo ou échange de clés incomplet',
            'error.selectImage': 'Veuillez sélectionner un fichier image'
        }
    };

    // Detect locale - use French if browser is French, otherwise English
    let currentLocale = 'en';

    // localStorage key for persisted language choice
    const STORAGE_KEY = 'imageSS_locale';

    /**
     * Detect browser locale and set current locale.
     * Checks localStorage first so user preference overrides browser default.
     */
    function detectLocale() {
        // User's explicit choice takes priority over browser locale
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && translations[saved]) {
            currentLocale = saved;
            console.log(`[i18n] Restored saved locale: ${currentLocale}`);
            return currentLocale;
        }
        const browserLang = navigator.language || navigator.userLanguage || 'en';
        // If locale starts with 'fr', use French
        currentLocale = browserLang.toLowerCase().startsWith('fr') ? 'fr' : 'en';
        console.log(`[i18n] Detected locale: ${browserLang}, using: ${currentLocale}`);
        return currentLocale;
    }

    /**
     * Get translation for a key with optional parameter substitution
     * @param {string} key - Translation key
     * @param {Object} params - Optional parameters for substitution (e.g., {count: 5})
     * @returns {string} Translated string
     */
    function t(key, params = {}) {
        const dict = translations[currentLocale] || translations.en;
        let text = dict[key] || translations.en[key] || key;

        // Substitute parameters
        for (const [param, value] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\{${param}\\}`, 'g'), value);
        }

        return text;
    }

    /**
     * Apply translations to all elements with data-i18n attribute
     */
    function applyTranslations() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translated = t(key);

            // Check if translation contains HTML
            if (translated.includes('<')) {
                el.innerHTML = translated;
            } else {
                el.textContent = translated;
            }
        });

        // Also apply to elements with data-i18n-placeholder for placeholders
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            el.placeholder = t(key);
        });

        // Apply to elements with data-i18n-title for title attributes
        // Skip <html> element — its title is handled below via document.title
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            if (el === document.documentElement) return;
            const key = el.getAttribute('data-i18n-title');
            el.title = t(key);
        });

        // Update document title if there's a matching key
        const pageTitleKey = document.documentElement.getAttribute('data-i18n-title');
        if (pageTitleKey) {
            document.title = t(pageTitleKey);
        }
    }

    /**
     * Initialize i18n - detect locale and apply translations
     */
    function init() {
        detectLocale();
        applyTranslations();

        // Update html lang attribute
        document.documentElement.lang = currentLocale;
    }

    /**
     * Get current locale
     * @returns {string} Current locale code ('en' or 'fr')
     */
    function getLocale() {
        return currentLocale;
    }

    /**
     * Set locale manually (for user preference or testing).
     * Persists the choice to localStorage so it survives page navigation.
     * @param {string} locale - Locale code ('en' or 'fr')
     */
    function setLocale(locale) {
        if (translations[locale]) {
            currentLocale = locale;
            // Persist so the user doesn't have to re-select on every page
            localStorage.setItem(STORAGE_KEY, locale);
            applyTranslations();
            document.documentElement.lang = currentLocale;
        }
    }

    // Public API
    return {
        init,
        t,
        getLocale,
        setLocale,
        detectLocale,
        applyTranslations
    };
})();
