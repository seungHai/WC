/**
 * 대똥여지도 (WC Map) - 통합 인증, 데이터베이스 및 감사 로그 레이어 (Supabase Cloud + Local DB)
 * - Supabase 연동 시: PostgreSQL RPC(SECURITY DEFINER + bcrypt + RLS)를 통해 서버사이드 인증, DB 동기화, 감사 로그(audit_logs) 자동 기록
 * - 미연동(초기) 상태 시: 브라우저 내장 보안 스토리지 엔진으로 동일하게 계정 부여, 화장실 제보/관리, 접속/활동 로그 기록 지원
 */
(function () {
        const STORAGE_KEYS = {
        SESSION_TOKEN: 'wc_session_token_v3',
        REMEMBER_ME: 'wc_remember_me',
        AUTO_GPS_ON_LOGIN: 'wc_auto_gps_on_login',
        SUPABASE_CUSTOM_CONFIG: 'wc_supabase_config',
        LOCAL_USERS: 'wc_local_users_v2',
        LOCAL_SESSIONS: 'wc_local_sessions_v2',
        LOCAL_RESTROOMS: 'wc_local_restrooms_v2',
        LOCAL_REVIEWS: 'wc_local_reviews_v2',
        LOCAL_LOGS: 'wc_local_audit_logs_v2',
        FAVORITES: 'wc_favorites_v2'
    };

    // 기존 map.html 에서 사용하던 SHA-256 해시 (관리자 호환용)
    const LEGACY_HASH = '1c0499527d85cce090bc770140b4f12fd66cc5fa64d8926cd99e3b674e663445';

    // 접속 기기/브라우저 및 IP·위치 정보 캐시
    let cachedTelemetry = null;

    function getDeviceSummary() {
        const ua = navigator.userAgent || '';
        let os = '기타 OS';
        if (/Windows/i.test(ua)) os = 'Windows';
        else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
        else if (/Android/i.test(ua)) os = 'Android';
        else if (/Macintosh|Mac OS X/i.test(ua)) os = 'macOS';
        else if (/Linux/i.test(ua)) os = 'Linux';

        let browser = 'Browser';
        if (/Edg\//i.test(ua)) browser = 'Edge';
        else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
        else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
        else if (/Firefox\//i.test(ua)) browser = 'Firefox';

        const screenStr = (window.screen && window.screen.width)
            ? `${window.screen.width}×${window.screen.height}`
            : '';
        const netStr = (navigator.connection && navigator.connection.effectiveType)
            ? navigator.connection.effectiveType.toUpperCase()
            : '';

        const extras = [screenStr, netStr].filter(Boolean).join(', ');
        return extras ? `${os} · ${browser} (${extras})` : `${os} · ${browser}`;
    }

    async function fetchWithTimeout(url, timeoutMs = 1800) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            return res;
        } catch (e) {
            clearTimeout(timer);
            throw e;
        }
    }

    async function collectClientTelemetry() {
        if (cachedTelemetry && cachedTelemetry.ip && cachedTelemetry.ip !== '확인중') {
            return cachedTelemetry;
        }

        const device = getDeviceSummary();
        let ip = '';
        let location = '';
        let isp = '';
        let coords = '';

        // 1차 시도: ipwho.is (HTTPS 무료, 한글 지역명 지원, CORS 허용)
        try {
            const res = await fetchWithTimeout('https://ipwho.is/?lang=ko', 1800);
            if (res.ok) {
                const data = await res.json();
                if (data && data.ip) {
                    ip = data.ip;
                    const regionParts = [data.region, data.city].filter(Boolean);
                    location = [...new Set(regionParts)].join(' ');
                    isp = (data.connection && (data.connection.isp || data.connection.org)) || '';
                    if (data.latitude && data.longitude) {
                        coords = `${Number(data.latitude).toFixed(4)}, ${Number(data.longitude).toFixed(4)}`;
                    }
                }
            }
        } catch (e) {
            // 폴백 진행
        }

        // 2차 폴백: ipapi.co
        if (!ip) {
            try {
                const res2 = await fetchWithTimeout('https://ipapi.co/json/', 1800);
                if (res2.ok) {
                    const data2 = await res2.json();
                    if (data2 && data2.ip) {
                        ip = data2.ip;
                        location = [data2.region, data2.city].filter(Boolean).join(' ');
                        isp = data2.org || '';
                        if (data2.latitude && data2.longitude) {
                            coords = `${Number(data2.latitude).toFixed(4)}, ${Number(data2.longitude).toFixed(4)}`;
                        }
                    }
                }
            } catch (e) {
                // 폴백 진행
            }
        }

        // 3차 폴백: ipify (IP만이라도 확실히 확보)
        if (!ip) {
            try {
                const res3 = await fetchWithTimeout('https://api.ipify.org?format=json', 1500);
                if (res3.ok) {
                    const data3 = await res3.json();
                    ip = data3.ip || '';
                }
            } catch (e) {
                // 무시
            }
        }

        // 배터리 정보 (지원 브라우저)
        let batteryStr = '';
        if (navigator.getBattery) {
            try {
                const bat = await navigator.getBattery();
                if (bat && typeof bat.level === 'number') {
                    batteryStr = `배터리 ${Math.round(bat.level * 100)}%${bat.charging ? '(충전중)' : ''}`;
                }
            } catch (e) {
                // 무시
            }
        }

        const locSummary = [location, isp ? `(${isp})` : ''].filter(Boolean).join(' ');
        // IP 기반 위경도 좌표는 통신사 기지국(서울 본사 등) 중심점이라 모든 접속자에게 동일하게 찍히므로,
        // 오해를 막기 위해 IP 좌표는 표시하지 않고 실제 브라우저 GPS 좌표가 확보되었을 때만 좌표를 표기합니다.
        const formattedInfo = [
            `IP: ${ip || '알수없음'}`,
            `위치: ${locSummary ? `${locSummary} (IP기반)` : '위치 미상'}`,
            `기기: ${device}${batteryStr ? ` · ${batteryStr}` : ''}`
        ].join(' | ');

        cachedTelemetry = {
            ip: ip || '알수없음',
            location: locSummary || '위치 미상',
            isp,
            coords: '',
            device,
            battery: batteryStr,
            formatted: formattedInfo
        };
        return cachedTelemetry;
    }

    // 위경도 좌표 -> 한국 지역/동네명 역지오코딩 (로그 기록용)
    async function reverseGeocodeForLog(lat, lng) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';

        // 1차: 카카오맵 Geocoder (로드되어 있는 경우)
        if (window.kakao && window.kakao.maps && window.kakao.maps.services) {
            try {
                const geocoder = new window.kakao.maps.services.Geocoder();
                const regionName = await new Promise((resolve) => {
                    geocoder.coord2RegionCode(lng, lat, (result, status) => {
                        if (status === window.kakao.maps.services.Status.OK && result && result.length > 0) {
                            const b = result.find(r => r.region_type === 'B') || result[0];
                            resolve(b.address_name || '');
                        } else {
                            resolve('');
                        }
                    });
                });
                if (regionName) return regionName;
            } catch (e) {
                // 폴백
            }
        }

        // 2차: BigDataCloud 한국어 역지오코딩 (빠르고 CORS 제한 없음)
        try {
            const res = await fetchWithTimeout(
                `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=ko`,
                1600
            );
            if (res.ok) {
                const data = await res.json();
                const parts = [data.principalSubdivision, data.city, data.locality].filter(Boolean);
                const unique = [...new Set(parts)];
                if (unique.length > 0) return unique.join(' ');
            }
        } catch (e) {
            // 무시
        }
        return '';
    }

    // 실제 브라우저 GPS 좌표(위도, 경도)를 텔레메트리 로그 문자열에 반영
    async function buildTelemetryWithGps(baseTelemetry, gpsCoords) {
        if (!gpsCoords || !Number.isFinite(gpsCoords.lat) || !Number.isFinite(gpsCoords.lng)) {
            return baseTelemetry;
        }
        const lat = Number(gpsCoords.lat);
        const lng = Number(gpsCoords.lng);
        const gpsCoordStr = `GPS ${lat.toFixed(6)}, ${lng.toFixed(6)}`;

        let regionName = gpsCoords.regionName || '';
        if (!regionName) {
            regionName = await reverseGeocodeForLog(lat, lng);
        }

        const ispSuffix = baseTelemetry.isp ? ` (${baseTelemetry.isp})` : '';
        const locText = regionName
            ? `${regionName}${ispSuffix} [${gpsCoordStr}]`
            : `${baseTelemetry.location && baseTelemetry.location !== '위치 미상' ? baseTelemetry.location + ' ' : ''}[${gpsCoordStr}]`;

        const formattedInfo = [
            `IP: ${baseTelemetry.ip || '알수없음'}`,
            `위치: ${locText}`,
            `기기: ${baseTelemetry.device}${baseTelemetry.battery ? ` · ${baseTelemetry.battery}` : ''}`
        ].join(' | ');

        return {
            ...baseTelemetry,
            location: regionName || baseTelemetry.location,
            coords: gpsCoordStr,
            formatted: formattedInfo
        };
    }

    // 페이지 로드 즉시 백그라운드에서 IP/위치 프리페치 (로그인 클릭 시 지연 시간 0초)
    collectClientTelemetry().catch(() => {});

    // SHA-256 해시 헬퍼 (Web Crypto API + 폴백)
    async function hashPassword(plainText) {
        if (window.crypto && window.crypto.subtle) {
            const msgBuffer = new TextEncoder().encode('wc_salt_v2_' + plainText);
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        }
        if (typeof window.sha256 === 'function') {
            return window.sha256('wc_salt_v2_' + plainText);
        }
        return btoa(encodeURIComponent('wc_salt_v2_' + plainText));
    }

    async function rawSha256(plainText) {
        if (typeof window.sha256 === 'function') {
            return window.sha256(plainText);
        }
        if (window.crypto && window.crypto.subtle) {
            const msgBuffer = new TextEncoder().encode(plainText);
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        }
        return '';
    }

    function generateUUID() {
        if (window.crypto && window.crypto.randomUUID) {
            return window.crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    class WCDatabaseService {
        constructor() {
            this.supabase = null;
            this.currentUser = null;
            this.initSupabaseClient();
        }

        /**
         * 대시보드 URL(supabase.com/dashboard/project/xxx/...)을 넣더라도
         * 자동으로 표준 API URL(https://xxx.supabase.co)로 정규화
         */
        normalizeSupabaseUrl(rawUrl) {
            const trimmed = (rawUrl || '').trim();
            if (!trimmed) return '';

            // 1. https://supabase.com/dashboard/project/{ref}/... 형태인 경우 자동 변환
            const dashMatch = trimmed.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
            if (dashMatch && dashMatch[1]) {
                return `https://${dashMatch[1].toLowerCase()}.supabase.co`;
            }

            // 2. https://{ref}.supabase.co/뒤에 불필요한 경로가 붙은 경우 도메인만 추출
            const apiMatch = trimmed.match(/https?:\/\/([a-z0-9-]+)\.supabase\.co/i);
            if (apiMatch && apiMatch[1]) {
                return `https://${apiMatch[1].toLowerCase()}.supabase.co`;
            }

            // 3. 프로젝트 ID(20자리 영문숫자)만 입력한 경우
            if (/^[a-z0-9]{15,25}$/i.test(trimmed)) {
                return `https://${trimmed.toLowerCase()}.supabase.co`;
            }

            return trimmed.replace(/\/+$/, '');
        }

        getSupabaseCredentials() {
            let url = this.normalizeSupabaseUrl(window.WC_CONFIG && window.WC_CONFIG.SUPABASE_URL);
            let anonKey = (window.WC_CONFIG && window.WC_CONFIG.SUPABASE_ANON_KEY || '').trim();

            try {
                const saved = localStorage.getItem(STORAGE_KEYS.SUPABASE_CUSTOM_CONFIG);
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (parsed.url && parsed.anonKey) {
                        const fixedUrl = this.normalizeSupabaseUrl(parsed.url);
                        const fixedKey = parsed.anonKey.trim();
                        url = fixedUrl;
                        anonKey = fixedKey;

                        // 잘못된 대시보드 URL이 저장되어 있었다면 자동 교정하여 다시 저장
                        if (fixedUrl !== parsed.url) {
                            localStorage.setItem(
                                STORAGE_KEYS.SUPABASE_CUSTOM_CONFIG,
                                JSON.stringify({ url: fixedUrl, anonKey: fixedKey })
                            );
                        }
                    }
                }
            } catch (e) {
                console.warn('Supabase 설정 로드 실패:', e);
            }

            return { url, anonKey };
        }

        initSupabaseClient() {
            const { url, anonKey } = this.getSupabaseCredentials();
            if (url && anonKey && window.supabase && typeof window.supabase.createClient === 'function') {
                try {
                    this.supabase = window.supabase.createClient(url, anonKey, {
                        auth: { persistSession: false }
                    });
                    return true;
                } catch (e) {
                    console.error('Supabase 클라이언트 초기화 오류:', e);
                    this.supabase = null;
                }
            } else {
                this.supabase = null;
            }
            return false;
        }

        isCloudMode() {
            return Boolean(this.supabase);
        }

        saveSupabaseCredentials(url, anonKey) {
            if (!url || !anonKey) {
                localStorage.removeItem(STORAGE_KEYS.SUPABASE_CUSTOM_CONFIG);
                this.supabase = null;
                return false;
            }
            const cleanUrl = this.normalizeSupabaseUrl(url);
            localStorage.setItem(
                STORAGE_KEYS.SUPABASE_CUSTOM_CONFIG,
                JSON.stringify({ url: cleanUrl, anonKey: anonKey.trim() })
            );
            return this.initSupabaseClient();
        }

        getToken() {
            return localStorage.getItem(STORAGE_KEYS.SESSION_TOKEN) ||
                   sessionStorage.getItem(STORAGE_KEYS.SESSION_TOKEN) ||
                   null;
        }

        setToken(token, rememberMe = true) {
            if (rememberMe) {
                localStorage.setItem(STORAGE_KEYS.SESSION_TOKEN, token);
                localStorage.setItem(STORAGE_KEYS.REMEMBER_ME, 'true');
                sessionStorage.removeItem(STORAGE_KEYS.SESSION_TOKEN);
            } else {
                sessionStorage.setItem(STORAGE_KEYS.SESSION_TOKEN, token);
                localStorage.removeItem(STORAGE_KEYS.SESSION_TOKEN);
                localStorage.setItem(STORAGE_KEYS.REMEMBER_ME, 'false');
            }
        }

        clearToken() {
            localStorage.removeItem(STORAGE_KEYS.SESSION_TOKEN);
            sessionStorage.removeItem(STORAGE_KEYS.SESSION_TOKEN);
            this.currentUser = null;
        }

        // ====================================================================
        // 로컬 감사 로그 기록 헬퍼
        // ====================================================================
        writeLocalLog(actionType, actorUsername, actorDisplayName, targetName = '', detail = '', customDeviceInfo = '') {
            try {
                const logs = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOGS) || '[]');
                const devInfo = customDeviceInfo || (cachedTelemetry && cachedTelemetry.formatted) || getDeviceSummary();
                logs.unshift({
                    id: 'log-' + generateUUID().slice(0, 8),
                    action_type: actionType,
                    actor_username: actorUsername || 'unknown',
                    actor_display_name: actorDisplayName || '',
                    target_name: targetName || '',
                    detail: detail || '',
                    device_info: devInfo,
                    created_at: new Date().toISOString()
                });
                if (logs.length > 300) logs.length = 300;
                localStorage.setItem(STORAGE_KEYS.LOCAL_LOGS, JSON.stringify(logs));
            } catch (e) {
                // 무시
            }
        }

        // ====================================================================
        // 로컬 DB 초기화 (Supabase 미연동 시 즉시 작동 보장)
        // ====================================================================
        async ensureLocalSeed() {
            let usersJson = localStorage.getItem(STORAGE_KEYS.LOCAL_USERS);
            if (!usersJson) {
                const adminHash = await hashPassword('admin1234');
                const sampleUserHash = await hashPassword('1234');
                const initialUsers = [
                    {
                        id: 'user-admin-001',
                        username: 'admin',
                        password_hash: adminHash,
                        display_name: '최고관리자',
                        role: 'admin',
                        is_active: true,
                        memo: '기본 관리자 계정 (초기 비번: admin1234 또는 기존 지도 비밀번호)',
                        created_at: new Date().toISOString(),
                        last_login_at: null
                    },
                    {
                        id: 'user-member-001',
                        username: 'user01',
                        password_hash: sampleUserHash,
                        display_name: '일반회원1',
                        role: 'user',
                        is_active: true,
                        memo: '테스트용 샘플 일반 계정 (초기 비번: 1234)',
                        created_at: new Date().toISOString(),
                        last_login_at: null
                    }
                ];
                localStorage.setItem(STORAGE_KEYS.LOCAL_USERS, JSON.stringify(initialUsers));
            }

            let restroomsJson = localStorage.getItem(STORAGE_KEYS.LOCAL_RESTROOMS);
            if (!restroomsJson) {
                const initialRestrooms = (window.WC_CONFIG && window.WC_CONFIG.INITIAL_RESTROOMS) || [];
                localStorage.setItem(STORAGE_KEYS.LOCAL_RESTROOMS, JSON.stringify(initialRestrooms));
            }
        }

        getLocalUsers() {
            try {
                return JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_USERS) || '[]');
            } catch (e) {
                return [];
            }
        }

        saveLocalUsers(users) {
            localStorage.setItem(STORAGE_KEYS.LOCAL_USERS, JSON.stringify(users));
        }

        getLocalSessions() {
            try {
                return JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SESSIONS) || '{}');
            } catch (e) {
                return {};
            }
        }

        saveLocalSessions(sessions) {
            localStorage.setItem(STORAGE_KEYS.LOCAL_SESSIONS, JSON.stringify(sessions));
        }

        // ====================================================================
        // 1. 로그인 / 세션 검증 / 로그아웃 / 비밀번호 변경
        // ====================================================================
        getAutoGpsPreference() {
            const val = localStorage.getItem(STORAGE_KEYS.AUTO_GPS_ON_LOGIN);
            return val === null ? true : val === 'true';
        }

        setAutoGpsPreference(enabled) {
            localStorage.setItem(STORAGE_KEYS.AUTO_GPS_ON_LOGIN, enabled ? 'true' : 'false');
        }

        async login(username, password, rememberMe = true, gpsCoords = null) {
            const cleanUsername = (username || '').trim();
            if (!cleanUsername || !password) {
                throw new Error('아이디와 비밀번호를 모두 입력해주세요.');
            }

            const baseTelemetry = await collectClientTelemetry();
            const telemetry = await buildTelemetryWithGps(baseTelemetry, gpsCoords);
            if (gpsCoords) {
                cachedTelemetry = telemetry;
            }

            if (this.isCloudMode()) {
                let res = await this.supabase.rpc('rpc_login', {
                    p_username: cleanUsername,
                    p_password: password,
                    p_device_info: telemetry.formatted
                });
                // 구버전 SQL 스키마(2개 인자)가 실행된 경우 자동 폴백
                if (res.error && /function.*rpc_login/i.test(res.error.message || '')) {
                    res = await this.supabase.rpc('rpc_login', {
                        p_username: cleanUsername,
                        p_password: password
                    });
                }
                const { data, error } = res;
                if (error) {
                    this.writeLocalLog('LOGIN_FAIL', cleanUsername, '미인증 시도', cleanUsername, error.message, telemetry.formatted);
                    throw new Error(error.message || '로그인에 실패했습니다.');
                }
                this.setToken(data.token, rememberMe);
                this.currentUser = data.user;
                this.writeLocalLog('LOGIN_SUCCESS', data.user.username, data.user.display_name, data.user.username, '정상 로그인 성공', telemetry.formatted);
                return data.user;
            }

            // 로컬 DB 모드 로그인
            await this.ensureLocalSeed();
            const users = this.getLocalUsers();
            const inputHash = await hashPassword(password);
            const rawHash = await rawSha256(password);

            const matchedUser = users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());
            const isLegacyAdminMatch =
                matchedUser &&
                matchedUser.username.toLowerCase() === 'admin' &&
                rawHash === LEGACY_HASH;

            if (!matchedUser || (matchedUser.password_hash !== inputHash && !isLegacyAdminMatch)) {
                this.writeLocalLog('LOGIN_FAIL', cleanUsername, '미인증 시도', cleanUsername, '비밀번호 불일치 또는 존재하지 않는 아이디');
                throw new Error('아이디 또는 비밀번호가 일치하지 않습니다.');
            }

            if (!matchedUser.is_active) {
                this.writeLocalLog('LOGIN_BLOCKED', matchedUser.username, matchedUser.display_name, matchedUser.username, '정지된 계정으로 로그인 시도');
                throw new Error('비활성화(접속 제한)된 계정입니다. 관리자에게 문의하세요.');
            }

            matchedUser.last_login_at = new Date().toISOString();
            this.saveLocalUsers(users);

            const token = 'local_' + generateUUID() + '_' + Date.now();
            const sessions = this.getLocalSessions();
            sessions[token] = {
                userId: matchedUser.id,
                expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
            };
            this.saveLocalSessions(sessions);

            const userPayload = {
                id: matchedUser.id,
                username: matchedUser.username,
                display_name: matchedUser.display_name,
                role: matchedUser.role
            };
            this.setToken(token, rememberMe);
            this.currentUser = userPayload;
            this.writeLocalLog('LOGIN_SUCCESS', matchedUser.username, matchedUser.display_name, matchedUser.username, '정상 로그인 성공');
            return userPayload;
        }

        async verifySession() {
            const token = this.getToken();
            if (!token) {
                this.currentUser = null;
                return null;
            }

            if (this.isCloudMode()) {
                try {
                    const { data, error } = await this.supabase.rpc('rpc_verify_session', {
                        p_token: token
                    });
                    if (error || !data) {
                        this.clearToken();
                        return null;
                    }
                    this.currentUser = data;
                    return data;
                } catch (e) {
                    this.clearToken();
                    return null;
                }
            }

            await this.ensureLocalSeed();
            const sessions = this.getLocalSessions();
            const session = sessions[token];
            if (!session || session.expiresAt < Date.now()) {
                this.clearToken();
                return null;
            }

            const users = this.getLocalUsers();
            const user = users.find(u => u.id === session.userId && u.is_active);
            if (!user) {
                this.clearToken();
                return null;
            }

            this.currentUser = {
                id: user.id,
                username: user.username,
                display_name: user.display_name,
                role: user.role
            };
            return this.currentUser;
        }

        async logout() {
            const token = this.getToken();
            const prevUser = this.currentUser;
            if (token) {
                if (this.isCloudMode()) {
                    try {
                        await this.supabase.rpc('rpc_logout', { p_token: token });
                    } catch (e) {
                        // 무시
                    }
                } else {
                    if (prevUser) {
                        this.writeLocalLog('LOGOUT', prevUser.username, prevUser.display_name, prevUser.username, '로그아웃');
                    }
                    const sessions = this.getLocalSessions();
                    delete sessions[token];
                    this.saveLocalSessions(sessions);
                }
            }
            this.clearToken();
        }

        async changeMyPassword(currentPassword, newPassword) {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');
            if (!newPassword || newPassword.length < 4) {
                throw new Error('새 비밀번호는 4자 이상 입력해주세요.');
            }

            if (this.isCloudMode()) {
                const { error } = await this.supabase.rpc('rpc_change_my_password', {
                    p_token: token,
                    p_current_password: currentPassword,
                    p_new_password: newPassword
                });
                if (error) throw new Error(error.message || '비밀번호 변경에 실패했습니다.');
                return true;
            }

            const user = await this.verifySession();
            if (!user) throw new Error('세션이 만료되었습니다.');

            const users = this.getLocalUsers();
            const idx = users.findIndex(u => u.id === user.id);
            if (idx === -1) throw new Error('사용자 정보를 찾을 수 없습니다.');

            const currentHash = await hashPassword(currentPassword);
            const rawHash = await rawSha256(currentPassword);
            const isLegacyAdminMatch =
                users[idx].username.toLowerCase() === 'admin' && rawHash === LEGACY_HASH;

            if (users[idx].password_hash !== currentHash && !isLegacyAdminMatch) {
                throw new Error('현재 비밀번호가 일치하지 않습니다.');
            }

            users[idx].password_hash = await hashPassword(newPassword);
            this.saveLocalUsers(users);
            this.writeLocalLog('PASSWORD_CHANGE', user.username, user.display_name, user.username, '본인 비밀번호 변경 완료');
            return true;
        }

        // ====================================================================
        // 2. 화장실 데이터 조회 / 추가(제보) / 수정 / 삭제
        // ====================================================================
        async getRestrooms() {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');

            if (this.isCloudMode()) {
                const { data, error } = await this.supabase.rpc('rpc_get_restrooms', {
                    p_token: token
                });
                if (error) throw new Error(error.message || '화장실 데이터를 불러오지 못했습니다.');
                return (data || []).map(item => ({
                    ...item,
                    lat: Number(item.lat),
                    lng: Number(item.lng)
                }));
            }

            await this.ensureLocalSeed();
            const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_RESTROOMS);
            const list = raw ? JSON.parse(raw) : [];
            return list.map(item => ({
                ...item,
                lat: Number(item.lat),
                lng: Number(item.lng)
            }));
        }

        async saveRestroom(payload) {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');

            if (this.isCloudMode()) {
                const isUuid = payload.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id);
                const { data, error } = await this.supabase.rpc('rpc_upsert_restroom', {
                    p_token: token,
                    p_id: isUuid ? payload.id : null,
                    p_name: payload.name || '',
                    p_location_detail: payload.location_detail || '',
                    p_floor: payload.floor || '1층',
                    p_lat: Number(payload.lat),
                    p_lng: Number(payload.lng),
                    p_pw_common: payload.pw_common || '',
                    p_pw_male: payload.pw_male || '',
                    p_pw_female: payload.pw_female || '',
                    p_gender_separated: Boolean(payload.gender_separated),
                    p_has_paper: payload.has_paper !== undefined ? Boolean(payload.has_paper) : true,
                    p_note: payload.note || '',
                    p_region: payload.region || '',
                    p_status: payload.status || 'approved'
                });
                if (error) throw new Error(error.message || '화장실 저장 중 오류가 발생했습니다.');
                return data;
            }

            await this.ensureLocalSeed();
            const user = await this.verifySession();
            if (!user) throw new Error('로그인이 필요합니다.');

            const list = await this.getRestrooms();
            const nowIso = new Date().toISOString();

            if (payload.id) {
                const idx = list.findIndex(r => r.id === payload.id);
                if (idx !== -1) {
                    list[idx] = {
                        ...list[idx],
                        name: (payload.name || '').trim(),
                        location_detail: (payload.location_detail || '').trim(),
                        floor: (payload.floor || '1층').trim(),
                        lat: Number(payload.lat),
                        lng: Number(payload.lng),
                        pw_common: (payload.pw_common || '').trim(),
                        pw_male: (payload.pw_male || '').trim(),
                        pw_female: (payload.pw_female || '').trim(),
                        gender_separated: Boolean(payload.gender_separated),
                        has_paper: payload.has_paper !== undefined ? Boolean(payload.has_paper) : true,
                        note: (payload.note || '').trim(),
                        region: (payload.region || '').trim(),
                        status: payload.status || list[idx].status || 'approved',
                        updated_at: nowIso
                    };
                    localStorage.setItem(STORAGE_KEYS.LOCAL_RESTROOMS, JSON.stringify(list));
                    this.writeLocalLog('RESTROOM_UPDATE', user.username, user.display_name, list[idx].name, `화장실 정보 수정 (${list[idx].location_detail} ${list[idx].floor})`);
                    return list[idx];
                }
            }

            const newItem = {
                id: 'wc-' + generateUUID().slice(0, 8),
                name: (payload.name || '').trim(),
                location_detail: (payload.location_detail || '').trim(),
                floor: (payload.floor || '1층').trim(),
                lat: Number(payload.lat),
                lng: Number(payload.lng),
                pw_common: (payload.pw_common || '').trim(),
                pw_male: (payload.pw_male || '').trim(),
                pw_female: (payload.pw_female || '').trim(),
                gender_separated: Boolean(payload.gender_separated),
                has_paper: payload.has_paper !== undefined ? Boolean(payload.has_paper) : true,
                note: (payload.note || '').trim(),
                region: (payload.region || '').trim(),
                status: 'approved',
                created_by: user.username,
                created_at: nowIso,
                updated_at: nowIso
            };

            list.unshift(newItem);
            localStorage.setItem(STORAGE_KEYS.LOCAL_RESTROOMS, JSON.stringify(list));
            this.writeLocalLog('RESTROOM_CREATE', user.username, user.display_name, newItem.name, `신규 화장실 등록 (${newItem.location_detail} ${newItem.floor})`);
            return newItem;
        }

        async deleteRestroom(id) {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');

            if (this.isCloudMode()) {
                const { error } = await this.supabase.rpc('rpc_delete_restroom', {
                    p_token: token,
                    p_id: id
                });
                if (error) throw new Error(error.message || '화장실 삭제에 실패했습니다.');
                return true;
            }

            const user = await this.verifySession();
            const list = await this.getRestrooms();
            const target = list.find(r => r.id === id);
            const filtered = list.filter(r => r.id !== id);
            localStorage.setItem(STORAGE_KEYS.LOCAL_RESTROOMS, JSON.stringify(filtered));
            if (user) {
                this.writeLocalLog('RESTROOM_DELETE', user.username, user.display_name, target ? target.name : id, '화장실 데이터 삭제');
            }
            return true;
        }

        // ====================================================================
        // 2-1. 전국 공중화장실 데이터 조회 (선택적 ON/OFF 토글용)
        // ====================================================================
        async getPublicRestrooms(options = {}) {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');

            const region = (options.region || '').trim();
            const keyword = (options.keyword || '').trim();
            const limit = options.limit || 800;
            const minLat = options.minLat !== undefined ? options.minLat : null;
            const maxLat = options.maxLat !== undefined ? options.maxLat : null;
            const minLng = options.minLng !== undefined ? options.minLng : null;
            const maxLng = options.maxLng !== undefined ? options.maxLng : null;

            if (this.isCloudMode()) {
                let res = await this.supabase.rpc('rpc_get_public_restrooms', {
                    p_token: token,
                    p_region: region,
                    p_keyword: keyword,
                    p_limit: limit,
                    p_min_lat: minLat,
                    p_max_lat: maxLat,
                    p_min_lng: minLng,
                    p_max_lng: maxLng
                });

                // 4개 인자 구버전 RPC로 생성된 경우 자동 폴백
                if (res.error && /function.*rpc_get_public_restrooms/i.test(res.error.message || '')) {
                    res = await this.supabase.rpc('rpc_get_public_restrooms', {
                        p_token: token,
                        p_region: region,
                        p_keyword: keyword,
                        p_limit: limit
                    });
                }

                if (!res.error && Array.isArray(res.data)) {
                    return res.data.map(item => this.normalizePublicRestroomItem(item));
                }
            }

            return [];
        }

        async getPublicRestroomsStats(options = {}) {
            const token = this.getToken();
            if (!token || !this.isCloudMode()) {
                return { total_count: 53585, in_view_count: null };
            }

            try {
                const { data, error } = await this.supabase.rpc('rpc_get_public_restrooms_stats', {
                    p_token: token,
                    p_keyword: (options.keyword || '').trim(),
                    p_min_lat: options.minLat !== undefined ? options.minLat : null,
                    p_max_lat: options.maxLat !== undefined ? options.maxLat : null,
                    p_min_lng: options.minLng !== undefined ? options.minLng : null,
                    p_max_lng: options.maxLng !== undefined ? options.maxLng : null
                });
                if (!error && data) {
                    return {
                        total_count: Number(data.total_count) || 53585,
                        in_view_count: Number(data.in_view_count) || 0
                    };
                }
            } catch (e) {
                // 아직 stats RPC가 미설치된 경우 기본값 반환
            }
            return { total_count: 53585, in_view_count: null };
        }

        normalizePublicRestroomItem(item) {
            const openInfo = [item.open_hours, item.open_hours_detail].filter(Boolean).join(' ');
            const facilityTags = [];
            if ((item.male_disabled_toilet_count || 0) + (item.female_disabled_toilet_count || 0) > 0) {
                facilityTags.push('♿ 장애인화장실');
            }
            if (item.diaper_table_yn) {
                facilityTags.push(`👶 기저귀교환대${item.diaper_table_location ? `(${item.diaper_table_location})` : ''}`);
            }
            if (item.emergency_bell_yn) {
                facilityTags.push('🔔 비상벨');
            }
            if (item.cctv_yn) {
                facilityTags.push('📹 입구CCTV');
            }

            const countSummary = `남(대변기 ${item.male_toilet_count || 0}·소변기 ${item.male_urinal_count || 0}) / 여(대변기 ${item.female_toilet_count || 0})`;
            const noteParts = [
                openInfo ? `개방시간: ${openInfo}` : '',
                countSummary,
                facilityTags.join(', '),
                item.managing_agency ? `관리: ${item.managing_agency}` : '',
                item.phone_number ? `☎ ${item.phone_number}` : ''
            ].filter(Boolean);

            return {
                id: 'pub-' + (item.id || item.manage_no),
                raw_id: item.id,
                is_public_data: true,
                manage_no: item.manage_no || '',
                category: item.category || '공중화장실',
                name: item.name || '공중화장실',
                location_detail: item.road_address || item.jibun_address || item.category || '공중화장실',
                road_address: item.road_address || '',
                jibun_address: item.jibun_address || '',
                floor: item.category || '공중화장실',
                lat: Number(item.lat),
                lng: Number(item.lng),
                pw_common: '',
                pw_male: '',
                pw_female: '',
                gender_separated: true,
                has_paper: true,
                note: noteParts.join(' | '),
                region: item.region || '',
                open_hours: openInfo || '상시/현장확인',
                managing_agency: item.managing_agency || '',
                phone_number: item.phone_number || '',
                male_toilet_count: item.male_toilet_count || 0,
                male_urinal_count: item.male_urinal_count || 0,
                female_toilet_count: item.female_toilet_count || 0,
                emergency_bell_yn: Boolean(item.emergency_bell_yn),
                cctv_yn: Boolean(item.cctv_yn),
                diaper_table_yn: Boolean(item.diaper_table_yn),
                status: 'approved',
                created_by: 'public_data'
            };
        }

        // ====================================================================
        // 3. 관리자 전용: 사용자 계정 부여(생성), 수정, 정지, 삭제 및 감사 로그 조회
        // ====================================================================
        async adminListUsers() {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');

            if (this.isCloudMode()) {
                const { data, error } = await this.supabase.rpc('rpc_admin_list_users', {
                    p_token: token
                });
                if (error) throw new Error(error.message || '사용자 목록을 불러올 수 없습니다.');
                return data || [];
            }

            const user = await this.verifySession();
            if (!user || user.role !== 'admin') {
                throw new Error('관리자 권한이 필요합니다.');
            }

            const users = this.getLocalUsers();
            return users.map(u => ({
                id: u.id,
                username: u.username,
                display_name: u.display_name,
                role: u.role,
                is_active: u.is_active,
                memo: u.memo || '',
                created_at: u.created_at,
                last_login_at: u.last_login_at
            }));
        }

        async adminSaveUser(payload) {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');

            if (this.isCloudMode()) {
                const { data, error } = await this.supabase.rpc('rpc_admin_save_user', {
                    p_token: token,
                    p_user_id: payload.id || null,
                    p_username: (payload.username || '').trim(),
                    p_password: payload.password || '',
                    p_display_name: (payload.display_name || '').trim(),
                    p_role: payload.role || 'user',
                    p_is_active: payload.is_active !== undefined ? Boolean(payload.is_active) : true,
                    p_memo: (payload.memo || '').trim()
                });
                if (error) throw new Error(error.message || '계정 저장에 실패했습니다.');
                return data;
            }

            const admin = await this.verifySession();
            if (!admin || admin.role !== 'admin') {
                throw new Error('관리자 권한이 필요합니다.');
            }

            const users = this.getLocalUsers();

            if (!payload.id) {
                const cleanUsername = (payload.username || '').trim();
                if (cleanUsername.length < 2) {
                    throw new Error('아이디는 2자 이상이어야 합니다.');
                }
                if (!payload.password || payload.password.length < 4) {
                    throw new Error('비밀번호는 4자 이상이어야 합니다.');
                }
                if (users.some(u => u.username.toLowerCase() === cleanUsername.toLowerCase())) {
                    throw new Error('이미 존재하는 아이디입니다.');
                }

                const newUser = {
                    id: 'user-' + generateUUID().slice(0, 8),
                    username: cleanUsername,
                    password_hash: await hashPassword(payload.password),
                    display_name: (payload.display_name || '').trim() || cleanUsername,
                    role: payload.role === 'admin' ? 'admin' : 'user',
                    is_active: payload.is_active !== undefined ? Boolean(payload.is_active) : true,
                    memo: (payload.memo || '').trim(),
                    created_at: new Date().toISOString(),
                    last_login_at: null
                };
                users.push(newUser);
                this.saveLocalUsers(users);
                this.writeLocalLog('USER_CREATE', admin.username, admin.display_name, newUser.username, `신규 회원 계정 발급 (이름: ${newUser.display_name}, 권한: ${newUser.role})`);
                return newUser;
            } else {
                const idx = users.findIndex(u => u.id === payload.id);
                if (idx === -1) throw new Error('대상 계정을 찾을 수 없습니다.');

                if (payload.display_name !== undefined && payload.display_name.trim()) {
                    users[idx].display_name = payload.display_name.trim();
                }
                if (payload.role !== undefined) {
                    users[idx].role = payload.role === 'admin' ? 'admin' : 'user';
                }
                if (payload.is_active !== undefined) {
                    users[idx].is_active = Boolean(payload.is_active);
                }
                if (payload.memo !== undefined) {
                    users[idx].memo = payload.memo.trim();
                }
                if (payload.password && payload.password.length >= 4) {
                    users[idx].password_hash = await hashPassword(payload.password);
                }
                this.saveLocalUsers(users);
                this.writeLocalLog('USER_UPDATE', admin.username, admin.display_name, users[idx].username, `계정 상태/정보 변경 (활성: ${users[idx].is_active ? '활성' : '정지'})`);
                return users[idx];
            }
        }

        async adminDeleteUser(userId) {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');

            if (this.isCloudMode()) {
                const { error } = await this.supabase.rpc('rpc_admin_delete_user', {
                    p_token: token,
                    p_user_id: userId
                });
                if (error) throw new Error(error.message || '계정 삭제에 실패했습니다.');
                return true;
            }

            const admin = await this.verifySession();
            if (!admin || admin.role !== 'admin') {
                throw new Error('관리자 권한이 필요합니다.');
            }
            if (admin.id === userId) {
                throw new Error('현재 로그인된 관리자 본인 계정은 삭제할 수 없습니다.');
            }

            const allUsers = this.getLocalUsers();
            const target = allUsers.find(u => u.id === userId);
            const users = allUsers.filter(u => u.id !== userId);
            this.saveLocalUsers(users);
            this.writeLocalLog('USER_DELETE', admin.username, admin.display_name, target ? target.username : userId, '사용자 계정 영구 삭제');
            return true;
        }

        async adminGetLogs(limit = 200) {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');

            if (this.isCloudMode()) {
                const { data, error } = await this.supabase.rpc('rpc_admin_get_logs', {
                    p_token: token,
                    p_limit: limit
                });
                if (!error && data) {
                    return data;
                }
                // DB에 rpc_admin_get_logs 함수가 아직 없는 경우 로컬 로그 폴백 반환
                try {
                    const logs = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOGS) || '[]');
                    return logs.slice(0, limit);
                } catch (e) {
                    return [];
                }
            }

            const admin = await this.verifySession();
            if (!admin || admin.role !== 'admin') {
                throw new Error('관리자 권한이 필요합니다.');
            }

            try {
                const logs = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOGS) || '[]');
                return logs.slice(0, limit);
            } catch (e) {
                return [];
            }
        }

        // ====================================================================
        // 4. 즐겨찾기 (사용자 브라우저별 빠른 접근)
        // ====================================================================
        getFavorites() {
            try {
                return JSON.parse(localStorage.getItem(STORAGE_KEYS.FAVORITES) || '[]');
            } catch (e) {
                return [];
            }
        }

        toggleFavorite(restroomId) {
            const favs = this.getFavorites();
            const idx = favs.indexOf(restroomId);
            if (idx === -1) {
                favs.push(restroomId);
            } else {
                favs.splice(idx, 1);
            }
            localStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(favs));
            return idx === -1;
        }

        // ====================================================================
        // 5. 화장실 평가 (별점 1~5 · 빠른 상태 태그 · 한줄평 코멘트)
        // ====================================================================
        getLocalAllReviews() {
            try {
                return JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_REVIEWS) || '[]');
            } catch (e) {
                return [];
            }
        }

        saveLocalAllReviews(reviews) {
            localStorage.setItem(STORAGE_KEYS.LOCAL_REVIEWS, JSON.stringify(reviews));
        }

        computeLocalReviewSummaries() {
            const reviews = this.getLocalAllReviews();
            const map = {};
            reviews.forEach(r => {
                const rid = String(r.restroom_id || '');
                if (!rid) return;
                if (!map[rid]) {
                    map[rid] = { sum: 0, count: 0 };
                }
                map[rid].sum += Number(r.rating) || 0;
                map[rid].count += 1;
            });
            const result = {};
            Object.keys(map).forEach(rid => {
                const item = map[rid];
                result[rid] = {
                    avg_rating: Number((item.sum / item.count).toFixed(1)),
                    review_count: item.count
                };
            });
            return result;
        }

        async getReviewSummaries() {
            const token = this.getToken();
            if (!token) return {};

            if (this.isCloudMode()) {
                try {
                    const { data, error } = await this.supabase.rpc('rpc_get_review_summaries', {
                        p_token: token
                    });
                    if (!error && Array.isArray(data)) {
                        const map = {};
                        data.forEach(row => {
                            if (row && row.restroom_id) {
                                map[String(row.restroom_id)] = {
                                    avg_rating: Number(row.avg_rating) || 0,
                                    review_count: Number(row.review_count) || 0
                                };
                            }
                        });
                        // 클라우드와 로컬 폴백 데이터 병합
                        const localMap = this.computeLocalReviewSummaries();
                        return { ...localMap, ...map };
                    }
                } catch (e) {
                    // DB에 아직 테이블이 없는 경우 로컬 요약으로 폴백
                }
            }
            return this.computeLocalReviewSummaries();
        }

        async getRestroomReviews(restroomId) {
            const token = this.getToken();
            if (!token || !restroomId) return [];
            const rid = String(restroomId);

            if (this.isCloudMode()) {
                try {
                    const { data, error } = await this.supabase.rpc('rpc_get_restroom_reviews', {
                        p_token: token,
                        p_restroom_id: rid
                    });
                    if (!error && Array.isArray(data)) {
                        return data;
                    }
                } catch (e) {
                    // 폴백
                }
            }

            return this.getLocalAllReviews()
                .filter(r => String(r.restroom_id) === rid)
                .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        }

        async saveRestroomReview(payload) {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');

            const rid = String(payload.restroom_id || '').trim();
            const rname = String(payload.restroom_name || '').trim();
            const rating = Math.max(1, Math.min(5, Number(payload.rating) || 5));
            const tags = Array.isArray(payload.tags) ? payload.tags : [];
            const comment = String(payload.comment || '').trim();

            if (!rid) throw new Error('평가할 화장실 정보가 없습니다.');

            if (this.isCloudMode()) {
                const { data, error } = await this.supabase.rpc('rpc_upsert_restroom_review', {
                    p_token: token,
                    p_restroom_id: rid,
                    p_restroom_name: rname,
                    p_rating: rating,
                    p_tags: tags,
                    p_comment: comment
                });
                if (!error && data) {
                    return data;
                }
                // 만약 클라우드 DB에 아직 restroom_reviews 테이블이 생성되지 않은 경우 로컬 스토리지로 안전하게 저장
                if (error && !/function.*rpc_upsert_restroom_review|relation.*restroom_reviews/i.test(error.message || '')) {
                    throw new Error(error.message || '평가 등록에 실패했습니다.');
                }
            }

            const user = this.currentUser || (await this.verifySession());
            if (!user) throw new Error('로그인이 필요합니다.');

            const all = this.getLocalAllReviews();
            const nowIso = new Date().toISOString();
            const existingIdx = all.findIndex(r => String(r.restroom_id) === rid && r.username === user.username);

            let savedItem;
            if (existingIdx !== -1) {
                all[existingIdx] = {
                    ...all[existingIdx],
                    display_name: user.display_name,
                    rating,
                    tags,
                    comment,
                    updated_at: nowIso
                };
                savedItem = all[existingIdx];
            } else {
                savedItem = {
                    id: 'rev-' + generateUUID(),
                    restroom_id: rid,
                    username: user.username,
                    display_name: user.display_name,
                    rating,
                    tags,
                    comment,
                    created_at: nowIso,
                    updated_at: nowIso
                };
                all.unshift(savedItem);
            }

            this.saveLocalAllReviews(all);
            this.writeLocalLog('REVIEW_UPSERT', user.username, user.display_name, rname || rid, `별점 ${rating}점 평가 등록 (${comment.slice(0, 30)})`);
            return savedItem;
        }

        async deleteRestroomReview(reviewId) {
            const token = this.getToken();
            if (!token) throw new Error('로그인이 필요합니다.');

            if (this.isCloudMode() && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(reviewId))) {
                const { error } = await this.supabase.rpc('rpc_delete_restroom_review', {
                    p_token: token,
                    p_review_id: reviewId
                });
                if (!error) return true;
            }

            const user = this.currentUser || (await this.verifySession());
            const all = this.getLocalAllReviews();
            const target = all.find(r => r.id === reviewId);
            const filtered = all.filter(r => r.id !== reviewId);
            this.saveLocalAllReviews(filtered);
            if (user && target) {
                this.writeLocalLog('REVIEW_DELETE', user.username, user.display_name, target.restroom_id, '화장실 평가 삭제');
            }
            return true;
        }

        // ====================================================================
        // 6. 사용자 상세 행동 로그 기록 (비동기 fire-and-forget, UI 지연 없음)
        // ====================================================================
        async logActivity(actionType, targetName = '', detail = '') {
            const token = this.getToken();
            if (!token || !actionType) return false;

            const user = this.currentUser;
            const deviceInfo = (cachedTelemetry && cachedTelemetry.formatted) || getDeviceSummary();

            // 로컬 로그에도 기록 (로컬 모드 및 폴백 확인용)
            if (user) {
                this.writeLocalLog(actionType, user.username, user.display_name, targetName, detail, deviceInfo);
            }

            if (this.isCloudMode()) {
                try {
                    await this.supabase.rpc('rpc_log_activity', {
                        p_token: token,
                        p_action_type: actionType,
                        p_target_name: String(targetName || '').slice(0, 120),
                        p_detail: String(detail || '').slice(0, 300),
                        p_device_info: deviceInfo
                    });
                } catch (e) {
                    // RPC 미설치 시에도 사용자 경험에 영향을 주지 않도록 무시
                }
            }
            return true;
        }
    }

    window.WCDB = new WCDatabaseService();
})();
