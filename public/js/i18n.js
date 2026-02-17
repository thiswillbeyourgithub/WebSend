/**
 * ImageSecureSend Internationalization (i18n) Module
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
            'app.name': 'ImageSecureSend',
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
            'about.title': 'About ImageSecureSend',
            'about.description': 'A secure, end-to-end encrypted photo transfer app designed for environments where data privacy is paramount.',
            'about.techStack': 'Tech Stack',
            'about.techStack.frontend': 'Vanilla HTML, CSS, JavaScript (no frameworks)',
            'about.techStack.transport': 'WebRTC peer-to-peer data channels',
            'about.techStack.encryption': 'ECDH key exchange + AES-GCM (Web Crypto API)',
            'about.techStack.signaling': 'Express.js server (SDP relay only)',
            'about.techStack.qr': 'qrcode.js / jsQR',
            'about.security': 'Security',
            'about.security.1': 'Photos are encrypted before leaving your device',
            'about.security.2': 'The server only relays connection metadata (SDP)',
            'about.security.3': 'Keys are generated fresh for each session',
            'about.security.4': 'Fingerprint verification prevents MITM attacks',
            'about.credits': 'Credits',
            'about.credits.text': 'Built with',
            'about.credits.link': 'Claude Code',
            'about.credits.suffix': '(AI-assisted development).',

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
            'send.connectedSecure': 'Connected securely!',
            'send.verified': 'Connection verified by both parties',
            'send.detectingConnection': 'Detecting connection type...',
            'send.howToSend': 'How would you like to send photos?',
            'send.takePhoto': 'Take New Photo',
            'send.choosePhoto': 'Choose Existing Photo',
            'send.capture': '📸 Take Photo',
            'send.backToOptions': '← Back to Options',
            'send.preview': 'Preview',
            'send.encrypting': 'Encrypting and sending...',
            'send.sendingProgress': 'Sending...',
            'send.sendPhoto': 'Send Photo',
            'send.retake': 'Retake / Choose Another',
            'send.sentSuccess': 'Photo sent successfully!',
            'send.sendAnother': 'Send Another Photo',
            'send.waitingConfirmation': '⏳ Waiting for receiver to confirm...',
            'send.invalidQR.secret': 'Invalid QR code - missing security token',
            'send.invalidQR.noRoom': 'Invalid QR code. Please scan the QR code from the receiver.',
            'send.invalidQR.secretMissing': 'Invalid QR code - security token missing. Please scan a fresh QR code.',
            'send.cameraError': 'Could not access camera. Please allow camera access or use manual input.',
            'send.cameraFailed': 'Could not access camera.',
            'send.sendFailed': 'Failed to send photo. Please try again.',
            'send.disconnected': 'Connection lost. Please start over.',

            // Receive page
            'receive.title': 'Receive Photos',
            'receive.scanSubtitle': 'Scan this QR code with your phone',
            'receive.generating': 'Generating secure connection...',
            'receive.waiting': 'Waiting for sender to scan...',
            'receive.connecting': 'Connecting...',
            'receive.connected': 'Connected!',
            'receive.failed': 'Connection failed. Please try again.',
            'receive.connectedWaiting': 'Connected! Waiting for photos...',
            'receive.waitingConfirmation': '⏳ Waiting for sender to confirm...',
            'receive.verified': 'Connection verified by both parties',
            'receive.detectingConnection': 'Detecting connection type...',
            'receive.receivedPhotos': 'Received Photos',
            'receive.photosPlaceholder': 'Photos will appear here as they are received.',
            'receive.downloadPdf': 'Download All as PDF',
            'receive.downloadPdfCount': 'Download All as PDF ({count} image{plural})',
            'receive.generatingPdf': '⏳ Generating PDF...',
            'receive.crop': '✂️ Crop',
            'receive.download': '📥 Download',
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

            // Errors
            'error.noPhotoOrKey': 'No photo or key exchange not complete',
            'error.selectImage': 'Please select an image file'
        },

        fr: {
            // Common
            'app.name': 'ImageSecureSend',
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
            'about.title': 'À propos de ImageSecureSend',
            'about.description': 'Une application de transfert de photos sécurisée, chiffrée de bout en bout, conçue pour les environnements médicaux où la confidentialité des données des patients est primordiale.',
            'about.techStack': 'Technologies',
            'about.techStack.frontend': 'HTML, CSS, JavaScript pur (sans framework)',
            'about.techStack.transport': 'Canaux de données WebRTC pair-à-pair',
            'about.techStack.encryption': 'Échange de clés ECDH + AES-GCM (Web Crypto API)',
            'about.techStack.signaling': 'Serveur Express.js (relais SDP uniquement)',
            'about.techStack.qr': 'qrcode.js / jsQR',
            'about.security': 'Sécurité',
            'about.security.1': 'Les photos sont chiffrées avant de quitter votre appareil',
            'about.security.2': 'Le serveur ne relaie que les métadonnées de connexion (SDP)',
            'about.security.3': 'Les clés sont générées à neuf pour chaque session',
            'about.security.4': 'La vérification d\'empreinte empêche les attaques MITM',
            'about.credits': 'Crédits',
            'about.credits.text': 'Développé avec',
            'about.credits.link': 'Claude Code',
            'about.credits.suffix': '(développement assisté par IA).',

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
            'send.connectedSecure': 'Connecté de manière sécurisée !',
            'send.verified': 'Connexion vérifiée par les deux parties',
            'send.detectingConnection': 'Détection du type de connexion...',
            'send.howToSend': 'Comment souhaitez-vous envoyer des photos ?',
            'send.takePhoto': 'Prendre une nouvelle photo',
            'send.choosePhoto': 'Choisir une photo existante',
            'send.capture': '📸 Prendre la photo',
            'send.backToOptions': '← Retour aux options',
            'send.preview': 'Aperçu',
            'send.encrypting': 'Chiffrement et envoi...',
            'send.sendingProgress': 'Envoi...',
            'send.sendPhoto': 'Envoyer la photo',
            'send.retake': 'Reprendre / Choisir une autre',
            'send.sentSuccess': 'Photo envoyée avec succès !',
            'send.sendAnother': 'Envoyer une autre photo',
            'send.waitingConfirmation': '⏳ En attente de confirmation du destinataire...',
            'send.invalidQR.secret': 'QR code invalide - jeton de sécurité manquant',
            'send.invalidQR.noRoom': 'QR code invalide. Veuillez scanner le QR code du destinataire.',
            'send.invalidQR.secretMissing': 'QR code invalide - jeton de sécurité manquant. Veuillez scanner un nouveau QR code.',
            'send.cameraError': 'Impossible d\'accéder à la caméra. Veuillez autoriser l\'accès à la caméra.',
            'send.cameraFailed': 'Impossible d\'accéder à la caméra.',
            'send.sendFailed': 'Échec de l\'envoi. Veuillez réessayer.',
            'send.disconnected': 'Connexion perdue. Veuillez recommencer.',

            // Receive page
            'receive.title': 'Recevoir des Photos',
            'receive.scanSubtitle': 'Scannez ce QR code avec votre téléphone',
            'receive.generating': 'Génération de la connexion sécurisée...',
            'receive.waiting': 'En attente du scan...',
            'receive.connecting': 'Connexion...',
            'receive.connected': 'Connecté !',
            'receive.failed': 'Échec de la connexion. Veuillez réessayer.',
            'receive.connectedWaiting': 'Connecté ! En attente des photos...',
            'receive.waitingConfirmation': '⏳ En attente de confirmation de l\'expéditeur...',
            'receive.verified': 'Connexion vérifiée par les deux parties',
            'receive.detectingConnection': 'Détection du type de connexion...',
            'receive.receivedPhotos': 'Photos reçues',
            'receive.photosPlaceholder': 'Les photos apparaîtront ici à mesure qu\'elles sont reçues.',
            'receive.downloadPdf': 'Télécharger tout en PDF',
            'receive.downloadPdfCount': 'Télécharger tout en PDF ({count} image{plural})',
            'receive.generatingPdf': '⏳ Génération du PDF...',
            'receive.crop': '✂️ Recadrer',
            'receive.download': '📥 Télécharger',
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

            // Errors
            'error.noPhotoOrKey': 'Pas de photo ou échange de clés incomplet',
            'error.selectImage': 'Veuillez sélectionner un fichier image'
        }
    };

    // Detect locale - use French if browser is French, otherwise English
    let currentLocale = 'en';

    /**
     * Detect browser locale and set current locale
     */
    function detectLocale() {
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
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
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
     * Set locale manually (for testing or user preference)
     * @param {string} locale - Locale code ('en' or 'fr')
     */
    function setLocale(locale) {
        if (translations[locale]) {
            currentLocale = locale;
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
