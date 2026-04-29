const express = require('express');
const app = express();

// Ограничиваем размер тела запроса (защита от исчерпания памяти / базовый DDoS)
app.use(express.json({ limit: '5kb' }));

// ==========================================
// ⚙️ КОНФИГУРАЦИЯ СЕРВЕРА
// ==========================================
const CONFIG = {
    MAX_PLAYERS: 2,
    LIGHT_DURATION_MS: 5000,
    REACTION_TIME_MS: 700,
    MIN_UPDATE_INTERVAL_MS: 80,   // ~12.5 тиков в секунду (anti-spam)
    MAX_SPEED_UNITS_PER_MS: 0.5,  // Максимальная скорость (юнитов в миллисекунду). Зависит от масштаба игры.
    MOVEMENT_THRESHOLD: 0.1,      // Порог микродвижений (защита от float-погрешностей)
    IDLE_TIMEOUT_MS: 30000        // Очистка АФК игроков (сборщик мусора)
};

// ==========================================
// 🧠 ИГРОВОЕ СОСТОЯНИЕ (STATE)
// ==========================================
const gameState = {
    light: 'green',
    redLightStartTime: 0
};

// Map безопаснее обычного {}, защищает от Prototype Pollution атак
const players = new Map();

// ==========================================
// 🔄 ИГРОВОЙ ЦИКЛ (GAME LOOP)
// ==========================================
setInterval(() => {
    if (gameState.light === 'green') {
        gameState.light = 'red';
        gameState.redLightStartTime = Date.now();
    } else {
        gameState.light = 'green';
    }
}, CONFIG.LIGHT_DURATION_MS);

// Очистка отключившихся/мертвых сессий (Memory Leak Prevention)
setInterval(() => {
    const now = Date.now();
    for (const [uid, player] of players.entries()) {
        if (now - player.lastUpdate > CONFIG.IDLE_TIMEOUT_MS) {
            players.delete(uid);
        }
    }
}, 10000);

// ==========================================
// 📡 API ЭНДПОИНТЫ
// ==========================================

// Вход в игру
app.post('/join', (req, res) => {
    const { uid } = req.body;

    // Валидация UID: строго строка, ограничение по длине
    if (typeof uid !== 'string' || uid.trim().length === 0 || uid.length > 50) {
        return res.status(400).json({ error: 'Invalid UID' });
    }

    if (players.has(uid)) {
        return res.json({ message: 'Already in room' });
    }

    if (players.size >= CONFIG.MAX_PLAYERS) {
        return res.status(403).json({ error: 'Room is full' });
    }

    // Инициализируем игрока. Клиент НЕ передает x, y или alive при старте.
    players.set(uid, {
        uid,
        x: 0,
        y: 0,
        alive: true,
        lastUpdate: Date.now()
    });

    res.json({ message: 'Joined successfully' });
});

// Обновление состояния игрока (Основной Game Logic & Anti-Cheat)
app.post('/update', (req, res) => {
    try {
        // Жесткая деструктуризация. Любые попытки клиента прокинуть { alive: true } будут проигнорированы.
        const { uid, x, y } = req.body;

        // 1. Валидация типов
        if (typeof uid !== 'string') return res.status(400).json({ error: 'Invalid UID' });
        // isFinite защищает от NaN, Infinity и попыток прокинуть строки/объекты вместо чисел
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return res.status(400).json({ error: 'Invalid coordinates' });
        }

        const player = players.get(uid);
        if (!player) return res.status(404).json({ error: 'Player not found' });

        // 2. Проверка состояния жизни
        if (!player.alive) {
            return res.status(403).json({ error: 'Dead players cannot move' });
        }

        const now = Date.now();
        const dt = now - player.lastUpdate;

        // 3. Anti-Spam
        if (dt < CONFIG.MIN_UPDATE_INTERVAL_MS) {
            return res.status(429).json({ error: 'Rate limit: updating too fast' });
        }

        // Вычисляем вектор смещения
        const dx = x - player.x;
        const dy = y - player.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // 4. Фильтр микродвижений (погрешности физики клиента)
        if (distance < CONFIG.MOVEMENT_THRESHOLD) {
            player.lastUpdate = now; // Обновляем таймер, но НЕ меняем координаты, чтобы предотвратить накопление сдвигов
            return res.json({ status: 'ok', alive: true });
        }

        // 5. Anti-Cheat: Speedhack / Teleport
        const maxAllowedDistance = (CONFIG.MAX_SPEED_UNITS_PER_MS * dt) + CONFIG.MOVEMENT_THRESHOLD;
        if (distance > maxAllowedDistance) {
            // Игрок движется неестественно быстро. Игнорируем пакет (Rubberbanding эффект на клиенте)
            return res.status(403).json({ error: 'Speedhack / Teleport detected' });
        }

        // 6. Логика Red Light
        if (gameState.light === 'red') {
            const timeInRedLight = now - gameState.redLightStartTime;
            if (timeInRedLight > CONFIG.REACTION_TIME_MS) {
                // Движение после времени реакции = Смерть
                player.alive = false;
                player.lastUpdate = now;
                return res.json({ status: 'dead', alive: false });
            }
        }

        // 7. Легитимное движение
        player.x = x;
        player.y = y;
        player.lastUpdate = now;

        return res.json({ status: 'ok', alive: true });

    } catch (err) {
        // Перехват любых непредвиденных ошибок, чтобы процесс не упал
        console.error('Update Error:', err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Глобальное состояние
app.get('/state', (req, res) => {
    res.json({
        light: gameState.light,
        players: Array.from(players.values())
    });
});

// Универсальные безопасные геттеры для одиночных значений
app.get('/:prop(x|y|alive)/:uid', (req, res) => {
    const { prop, uid } = req.params;
    const player = players.get(uid);
    
    // Дефолтные значения, если игрок не найден
    const defaultValue = prop === 'alive' ? false : 0;
    
    res.json({ [prop]: player ? player[prop] : defaultValue });
});

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Squid Game Server is running on port ${PORT}`);
});