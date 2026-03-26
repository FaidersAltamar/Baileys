import express, { Request, Response } from 'express'
import cors from 'cors'
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '../src'
import { Boom } from '@hapi/boom'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express()
app.use(cors())
app.use(express.json())

// Servir la documentación interactiva en la raíz
app.get('/', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'docs.html'));
});

const logger = P({ level: 'silent' })

interface SessionData {
    sock: ReturnType<typeof makeWASocket> | null;
    qr: string | null;
    status: string;
}

// Stores all active WhatsApp instances
const sessions = new Map<string, SessionData>();

// Helper to reconnect existing sessions on startup
function autoRestartSessions() {
    // Busca carpetas de auth creadas
    if (!fs.existsSync('./')) return;
    const files = fs.readdirSync('./');
    for (const file of files) {
        if (file.startsWith('baileys_auth_')) {
            const id = file.replace('baileys_auth_', '');
            console.log(`Auto-starting session: ${id}`);
            startSession(id);
        }
    }
}

// Inicia o reconecta una instancia
async function startSession(sessionId: string) {
    const authFolder = `baileys_auth_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { sock: null, qr: null, status: 'checking' });
    }
    const sessionData = sessions.get(sessionId)!;

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
    })

    sessionData.sock = sock;

    sock.ev.process(async (events) => {
        if (events['connection.update']) {
            const update = events['connection.update']
            const { connection, lastDisconnect, qr } = update

            if (qr) {
                sessionData.qr = qr;
                console.log(`\n--- NEW QR CODE PARA LA INSTANCIA: ${sessionId} ---`);
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                sessionData.status = 'disconnected';
                sessionData.qr = null;
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
                if (shouldReconnect) {
                    startSession(sessionId) // reconexión automática
                } else {
                    console.log(`[${sessionId}] Connection closed. You are logged out.`)
                    sessions.delete(sessionId);
                    fs.rmSync(authFolder, { recursive: true, force: true });
                }
            } else if (connection === 'open') {
                sessionData.status = 'connected';
                sessionData.qr = null;
                console.log(`[${sessionId}] Successfully connected!`)
            } else if (connection === 'connecting') {
                sessionData.status = 'connecting'
            }
        }

        if (events['creds.update']) {
            await saveCreds()
        }
    })
}

// ============================================
// API Endpoints para manejar múltiples instancias
// ============================================

// 1. Iniciar o conectar instancia
app.post('/api/sessions/start', async (req: Request, res: Response): Promise<any> => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'El campo "id" de la instancia es requerido' });

    if (sessions.has(id)) {
        const status = sessions.get(id)?.status;
        return res.status(400).json({ error: `Instancia '${id}' ya se encuentra asociada, estado: ${status}` });
    }

    startSession(id);
    res.json({ success: true, message: `Instancia '${id}' iniciada, haz un GET a /api/sessions/${id}/status para ver el QR.` });
});

// 2. Estado de instancia (ver QR)
app.get('/api/sessions/:id/status', (req: Request, res: Response): Promise<any> => {
    const { id } = req.params;
    const session = sessions.get(id);

    if (!session) {
        return res.status(404).json({ error: `Instancia '${id}' no existe` });
    }

    res.json({
        id,
        status: session.status,
        qr: session.qr
    });
});

// 3. Cerrar sesión
app.delete('/api/sessions/:id', async (req: Request, res: Response): Promise<any> => {
    const { id } = req.params;
    const session = sessions.get(id);

    if (!session || !session.sock) {
        return res.status(404).json({ error: `Instancia '${id}' no existe o no está activa` });
    }

    await session.sock.logout();
    // La eliminación de carpetas y de sessions.delete(id) se hace automáticamente 
    // en el evento `connection.update === 'close'` que lanzamos arriba.

    res.json({ success: true, message: `Instancia '${id}' cerrada y eliminada correctamente` });
});

// 4. Enviar texto a través de una instancia seleccionada
app.post('/api/sessions/:id/send/text', async (req: Request, res: Response): Promise<any> => {
    try {
        const { id } = req.params;
        const session = sessions.get(id);

        if (!session || !session.sock || session.status !== 'connected') {
            return res.status(400).json({ error: `WhatsApp instancia '${id}' no está conectada` });
        }

        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ error: 'Número y mensaje son requeridos' });
        }

        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        const result = await session.sock.sendMessage(jid, { text: message });

        res.json({ success: true, result });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Enviar media a través de una instancia seleccionada
app.post('/api/sessions/:id/send/media', async (req: Request, res: Response): Promise<any> => {
    try {
        const { id } = req.params;
        const session = sessions.get(id);

        if (!session || !session.sock || session.status !== 'connected') {
            return res.status(400).json({ error: `WhatsApp instancia '${id}' no está conectada` });
        }

        const { number, caption, url } = req.body;
        if (!number || !url) {
            return res.status(400).json({ error: 'Número y URL son requeridos' });
        }

        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        const result = await session.sock.sendMessage(jid, {
            image: { url },
            caption: caption || ''
        });

        res.json({ success: true, result });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`\n===========================================`)
    console.log(`🚀 Multi-Device WhatsApp API Server on port ${PORT}`)
    console.log(`===========================================\n`)

    // Auto arrancar las sesiones guardadas (reconectar automáticamente si reinicias tu PC)
    autoRestartSessions();
})
