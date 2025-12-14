// voice-processor.js - Robust Live Translation with Sentence Accumulation
const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Translate } = require("@google-cloud/translate").v2;

// Support for cloud deployment: read credentials from env var
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
    googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
}

class VoiceProcessor {
    constructor(websocket, activeSessions) {
        this.ws = websocket;
        this.activeSessions = activeSessions;

        // Google Cloud clients (use env credentials if available)
        const clientConfig = googleCredentials ? { credentials: googleCredentials } : {};
        this.speechClient = new speech.SpeechClient(clientConfig);
        this.ttsClient = new textToSpeech.TextToSpeechClient(clientConfig);
        this.translateClient = new Translate(googleCredentials ? { credentials: googleCredentials } : {});

        // User info
        this.roomId = null;
        this.userType = null;
        this.myLanguage = null;
        this.myName = null;

        // STT state - SIMPLIFIED
        this.recognizeStream = null;
        this.isStreaming = false;
        this.streamCreatedAt = 0;

        // Sentence building - THE KEY FIX
        this.sentence = "";           // Current accumulated sentence (from finals)
        this.lastInterim = "";        // Backup: latest interim result
        this.lastSentence = "";       // Last processed sentence
        this.sentenceTimer = null;    // Timer to finalize sentence
        this.SENTENCE_TIMEOUT = 3000; // 3 seconds of silence = end of sentence

        // Processing lock
        this.isProcessing = false;

        // Bind handlers
        this._handleSTTData = this._handleSTTData.bind(this);
        this._handleSTTError = this._handleSTTError.bind(this);
    }

    async handleMessage(msg) {
        switch (msg.event) {
            case "connected":
                this.roomId = msg.roomId;
                this.userType = msg.userType;
                this.myLanguage = msg.myLanguage;
                this.myName = msg.myName || "User";
                console.log(`✅ ${this.userType} connected in ${this.roomId} (${this.myLanguage})`);
                this._registerConnection();
                this._notifyPartner("user_joined", { name: this.myName, language: this.myLanguage });
                break;
            case "audio":
                await this._processAudio(msg.audio);
                break;
            case "disconnect":
            case "stop":
                await this.cleanup();
                break;
        }
    }

    _registerConnection() {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;
        if (this.userType === "caller") session.callerConnection = this;
        else session.receiverConnection = this;
    }

    async _processAudio(base64Audio) {
        if (!this.myLanguage) return;

        const buffer = Buffer.from(base64Audio, "base64");

        // Ensure stream is running
        if (!this.isStreaming) {
            await this._startStream();
        }

        // Check if we need to restart (Google has ~60s limit)
        const streamAge = Date.now() - this.streamCreatedAt;
        if (streamAge > 50000) { // Restart every 50s for safety
            console.log("🔄 Restarting stream (age limit)");
            await this._restartStream();
        }

        // Send ALL audio to Google (let it decide what's speech)
        if (this.recognizeStream) {
            try {
                this.recognizeStream.write(buffer);
            } catch (e) {
                console.error("Write error:", e.message);
                await this._restartStream();
            }
        }

        // DON'T reset timer here - only reset when we get actual STT results
    }

    async _startStream() {
        if (this.isStreaming) return;

        const langCode = this._getLangCode(this.myLanguage);

        try {
            this.recognizeStream = this.speechClient
                .streamingRecognize({
                    config: {
                        encoding: "LINEAR16",
                        sampleRateHertz: 48000,
                        languageCode: langCode,
                        enableAutomaticPunctuation: true,
                        model: "latest_long",
                        useEnhanced: true
                    },
                    interimResults: true,
                    singleUtterance: false
                })
                .on("data", this._handleSTTData)
                .on("error", this._handleSTTError)
                .on("end", () => {
                    this.isStreaming = false;
                    this.recognizeStream = null;
                });

            this.isStreaming = true;
            this.streamCreatedAt = Date.now();
            console.log(`🎤 Stream started: ${langCode}`);
        } catch (e) {
            console.error("Failed to start stream:", e.message);
            this.isStreaming = false;
        }
    }

    async _stopStream() {
        if (this.recognizeStream) {
            try { this.recognizeStream.end(); } catch (e) { }
        }
        this.recognizeStream = null;
        this.isStreaming = false;
    }

    async _restartStream() {
        const savedSentence = this.sentence;
        await this._stopStream();
        this.sentence = savedSentence;
        await this._startStream();
    }

    _handleSTTData(response) {
        if (!response.results?.[0]) return;

        const result = response.results[0];
        const transcript = result.alternatives?.[0]?.transcript?.trim();
        if (!transcript) return;

        const isFinal = result.isFinal;

        if (isFinal) {
            // ACCUMULATE final results into the sentence
            if (this.sentence) {
                this.sentence += " " + transcript;
            } else {
                this.sentence = transcript;
            }
            this.lastInterim = ""; // Clear interim since we got final
            console.log(`📝 Accumulated: "${this.sentence}"`);
        } else {
            // Save interim as backup (in case stream times out)
            const preview = this.sentence ? this.sentence + " " + transcript : transcript;
            this.lastInterim = preview; // SAVE FOR BACKUP
            console.log(`⏳ Speaking: "${preview}"`);
            this._sendToUI({ event: "transcript_interim", text: preview });
        }

        // Reset timer - user is still speaking
        this._resetSentenceTimer();
    }

    _handleSTTError(err) {
        const msg = err.message || "";
        if (msg.includes("Audio Timeout") || msg.includes("OUT_OF_RANGE") || err.code === 11) {
            console.log("⏰ Stream timeout (normal)");
        } else {
            console.error("❌ STT Error:", msg);
        }

        this.isStreaming = false;
        this.recognizeStream = null;

        // Use interim as backup if no finals accumulated
        if (!this.sentence && this.lastInterim && this.lastInterim !== this.lastSentence) {
            console.log(`🔄 Using interim backup: "${this.lastInterim}"`);
            this.sentence = this.lastInterim;
        }

        // Process any accumulated sentence
        if (this.sentence && this.sentence !== this.lastSentence) {
            this._finalizeSentence();
        }

        this.lastInterim = ""; // Clear interim after use
    }

    _resetSentenceTimer() {
        if (this.sentenceTimer) {
            clearTimeout(this.sentenceTimer);
        }
        this.sentenceTimer = setTimeout(() => {
            this._finalizeSentence();
        }, this.SENTENCE_TIMEOUT);
    }

    _finalizeSentence() {
        if (this.sentenceTimer) {
            clearTimeout(this.sentenceTimer);
            this.sentenceTimer = null;
        }

        if (!this.sentence || this.sentence === this.lastSentence) {
            return;
        }

        const finalSentence = this.sentence.trim();
        console.log(`\n🔵 SENTENCE COMPLETE: "${finalSentence}"\n`);

        this.lastSentence = finalSentence;
        this.sentence = "";

        // Translate and speak
        this._translateAndSpeak(finalSentence);
    }

    async _translateAndSpeak(text) {
        if (this.isProcessing || !text) return;
        this.isProcessing = true;

        const start = Date.now();

        try {
            const session = this.activeSessions.get(this.roomId);
            if (!session) return;

            const partner = this.userType === "caller"
                ? session.receiverConnection
                : session.callerConnection;

            if (!partner?.myLanguage) {
                console.log("⚠️ Partner not connected");
                return;
            }

            // Translate
            const translated = await this._translate(text, this.myLanguage, partner.myLanguage);
            console.log(`🌐 [${Date.now() - start}ms] "${text}" → "${translated}"`);

            // Send to both users
            const data = {
                event: "translation",
                originalText: text,
                translatedText: translated,
                fromUser: this.userType,
                fromLanguage: this.myLanguage,
                toLanguage: partner.myLanguage
            };
            this._sendToUI(data);
            partner._sendToUI(data);

            // Generate TTS
            const audio = await this._tts(translated, partner.myLanguage);
            if (audio && partner.ws?.readyState === 1) {
                const wav = this._toWav(audio, 48000);
                partner.ws.send(JSON.stringify({
                    event: "audio_playback",
                    audio: wav.toString("base64"),
                    format: "wav"
                }));
                console.log(`🔊 [${Date.now() - start}ms] TTS sent to partner`);
            }
        } catch (e) {
            console.error("Translation error:", e.message);
        } finally {
            this.isProcessing = false;
        }
    }

    async _translate(text, from, to) {
        const fromLang = (from || "en").split("-")[0];
        const toLang = (to || "en").split("-")[0];
        if (fromLang === toLang) return text;

        try {
            const [result] = await this.translateClient.translate(text, { from: fromLang, to: toLang });
            return result;
        } catch (e) {
            console.error("Translate error:", e.message);
            return text;
        }
    }

    async _tts(text, lang) {
        const voices = {
            en: { languageCode: "en-US", name: "en-US-Neural2-J" },
            es: { languageCode: "es-ES", name: "es-ES-Neural2-A" },
            hi: { languageCode: "hi-IN", name: "hi-IN-Neural2-A" },
            te: { languageCode: "te-IN", name: "te-IN-Standard-A" },
            ta: { languageCode: "ta-IN", name: "ta-IN-Standard-A" },
            fr: { languageCode: "fr-FR", name: "fr-FR-Neural2-A" },
            de: { languageCode: "de-DE", name: "de-DE-Neural2-A" }
        };

        const base = (lang || "en").split("-")[0];
        const voice = voices[base] || { languageCode: lang, ssmlGender: "NEUTRAL" };

        try {
            const [response] = await this.ttsClient.synthesizeSpeech({
                input: { text },
                voice,
                audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 48000, speakingRate: 1.1 }
            });
            return response.audioContent;
        } catch (e) {
            console.error("TTS error:", e.message);
            return null;
        }
    }

    _getLangCode(lang) {
        const map = {
            en: "en-US", hi: "hi-IN", te: "te-IN", ta: "ta-IN",
            es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR",
            ru: "ru-RU", zh: "cmn-CN", ja: "ja-JP", ko: "ko-KR", ar: "ar-XA"
        };
        return map[(lang || "en").split("-")[0]] || "en-US";
    }

    _toWav(pcm, rate) {
        const h = Buffer.alloc(44);
        h.write("RIFF", 0);
        h.writeUInt32LE(36 + pcm.length, 4);
        h.write("WAVE", 8);
        h.write("fmt ", 12);
        h.writeUInt32LE(16, 16);
        h.writeUInt16LE(1, 20);
        h.writeUInt16LE(1, 22);
        h.writeUInt32LE(rate, 24);
        h.writeUInt32LE(rate * 2, 28);
        h.writeUInt16LE(2, 32);
        h.writeUInt16LE(16, 34);
        h.write("data", 36);
        h.writeUInt32LE(pcm.length, 40);
        return Buffer.concat([h, pcm]);
    }

    _sendToUI(data) {
        try {
            if (this.ws?.readyState === 1) {
                this.ws.send(JSON.stringify(data));
            }
        } catch (e) { }
    }

    _notifyPartner(event, data) {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;
        const partner = this.userType === "caller" ? session.receiverConnection : session.callerConnection;
        if (partner?.ws?.readyState === 1) {
            partner.ws.send(JSON.stringify({ event, ...data }));
        }
    }

    async cleanup() {
        if (this.sentenceTimer) {
            clearTimeout(this.sentenceTimer);
            this.sentenceTimer = null;
        }

        // Process any remaining sentence
        if (this.sentence && this.sentence !== this.lastSentence) {
            this._finalizeSentence();
        }

        await this._stopStream();

        const session = this.activeSessions.get(this.roomId);
        if (session) {
            if (session.callerConnection === this) session.callerConnection = null;
            if (session.receiverConnection === this) session.receiverConnection = null;
        }

        this._notifyPartner("user_left", {});
        console.log(`🧹 Cleanup: ${this.userType} in ${this.roomId}`);
    }
}

module.exports = VoiceProcessor;
