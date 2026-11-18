-- ============================================================================
-- 대똥여지도 (WC Map) - Supabase PostgreSQL Schema, Audit Logs & RPC Functions
-- 사용법: Supabase 대시보드 -> SQL Editor -> New Query 에 전체 붙여넣기 후 Run 클릭
-- ============================================================================

-- 1. 암호화 확장 모듈 활성화 (비밀번호 bcrypt 해싱 및 보안 토큰 생성용)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. 사용자 계정 테이블 (관리자가 직접 부여하는 계정 전용, 외부 회원가입 불가)
CREATE TABLE IF NOT EXISTS public.app_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL CHECK (char_length(trim(username)) >= 2),
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    memo TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- 3. 로그인 세션 토큰 테이블
CREATE TABLE IF NOT EXISTS public.user_sessions (
    token TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')
);

-- 4. 화장실 정보 테이블
CREATE TABLE IF NOT EXISTS public.restrooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    location_detail TEXT NOT NULL DEFAULT '',
    floor TEXT NOT NULL DEFAULT '1층',
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    pw_common TEXT DEFAULT '',
    pw_male TEXT DEFAULT '',
    pw_female TEXT DEFAULT '',
    gender_separated BOOLEAN NOT NULL DEFAULT false,
    has_paper BOOLEAN NOT NULL DEFAULT true,
    note TEXT DEFAULT '',
    region TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'pending')),
    created_by TEXT DEFAULT 'admin',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. 접속 및 활동 감사 로그(Audit Logs) 테이블
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_type TEXT NOT NULL,
    actor_username TEXT NOT NULL DEFAULT 'unknown',
    actor_display_name TEXT NOT NULL DEFAULT '',
    target_name TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    device_info TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Row Level Security (RLS) 활성화 - 인증 토큰 없이 테이블 직접 조회/수정 원천 차단
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restrooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 내부 헬퍼 함수 1: 세션 토큰 검증
-- ============================================================================
CREATE OR REPLACE FUNCTION public.internal_validate_token(p_token TEXT)
RETURNS public.app_users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
BEGIN
    IF p_token IS NULL OR trim(p_token) = '' THEN
        RAISE EXCEPTION '로그인이 필요합니다.';
    END IF;

    SELECT u.* INTO v_user
    FROM public.user_sessions s
    JOIN public.app_users u ON u.id = s.user_id
    WHERE s.token = p_token
      AND s.expires_at > now()
      AND u.is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION '세션이 만료되었거나 유효하지 않은 계정입니다. 다시 로그인해주세요.';
    END IF;

    RETURN v_user;
END;
$$;

-- ============================================================================
-- 내부 헬퍼 함수 2: 감사 로그 기록
-- ============================================================================
CREATE OR REPLACE FUNCTION public.internal_write_log(
    p_action_type TEXT,
    p_actor_username TEXT,
    p_actor_display_name TEXT,
    p_target_name TEXT DEFAULT '',
    p_detail TEXT DEFAULT '',
    p_device_info TEXT DEFAULT ''
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    INSERT INTO public.audit_logs (
        action_type, actor_username, actor_display_name, target_name, detail, device_info
    ) VALUES (
        p_action_type,
        COALESCE(p_actor_username, 'unknown'),
        COALESCE(p_actor_display_name, ''),
        COALESCE(p_target_name, ''),
        COALESCE(p_detail, ''),
        COALESCE(p_device_info, '')
    );
END;
$$;

-- ============================================================================
-- [인증 RPC 1] 로그인 (아이디 + 비밀번호 검증 후 세션 토큰 발급 + 접속 로그 기록)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_login(
    p_username TEXT,
    p_password TEXT,
    p_device_info TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
    v_token TEXT;
BEGIN
    SELECT * INTO v_user
    FROM public.app_users
    WHERE lower(username) = lower(trim(p_username));

    IF NOT FOUND OR v_user.password_hash <> crypt(p_password, v_user.password_hash) THEN
        PERFORM public.internal_write_log(
            'LOGIN_FAIL',
            trim(p_username),
            '미인증 시도',
            trim(p_username),
            '비밀번호 불일치 또는 존재하지 않는 아이디',
            p_device_info
        );
        RAISE EXCEPTION '아이디 또는 비밀번호가 일치하지 않습니다.';
    END IF;

    IF NOT v_user.is_active THEN
        PERFORM public.internal_write_log(
            'LOGIN_BLOCKED',
            v_user.username,
            v_user.display_name,
            v_user.username,
            '정지된 계정으로 로그인 시도',
            p_device_info
        );
        RAISE EXCEPTION '비활성화(접속 제한)된 계정입니다. 관리자에게 문의하세요.';
    END IF;

    -- 만료된 세션 정리 및 신규 토큰 발급
    DELETE FROM public.user_sessions WHERE user_id = v_user.id AND expires_at <= now();
    v_token := encode(gen_random_bytes(32), 'hex');

    INSERT INTO public.user_sessions (token, user_id, expires_at)
    VALUES (v_token, v_user.id, now() + INTERVAL '30 days');

    UPDATE public.app_users SET last_login_at = now() WHERE id = v_user.id;

    PERFORM public.internal_write_log(
        'LOGIN_SUCCESS',
        v_user.username,
        v_user.display_name,
        v_user.username,
        '정상 로그인 성공',
        p_device_info
    );

    RETURN jsonb_build_object(
        'token', v_token,
        'user', jsonb_build_object(
            'id', v_user.id,
            'username', v_user.username,
            'display_name', v_user.display_name,
            'role', v_user.role
        )
    );
END;
$$;

-- ============================================================================
-- [인증 RPC 2] 세션 확인 (자동 로그인 검증)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_verify_session(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
BEGIN
    v_user := public.internal_validate_token(p_token);
    RETURN jsonb_build_object(
        'id', v_user.id,
        'username', v_user.username,
        'display_name', v_user.display_name,
        'role', v_user.role
    );
END;
$$;

-- ============================================================================
-- [인증 RPC 3] 로그아웃
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_logout(p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
BEGIN
    BEGIN
        v_user := public.internal_validate_token(p_token);
        PERFORM public.internal_write_log(
            'LOGOUT',
            v_user.username,
            v_user.display_name,
            v_user.username,
            '로그아웃',
            ''
        );
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    DELETE FROM public.user_sessions WHERE token = p_token;
    RETURN true;
END;
$$;

-- ============================================================================
-- [인증 RPC 4] 내 비밀번호 변경
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_change_my_password(
    p_token TEXT,
    p_current_password TEXT,
    p_new_password TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
BEGIN
    v_user := public.internal_validate_token(p_token);

    IF v_user.password_hash <> crypt(p_current_password, v_user.password_hash) THEN
        RAISE EXCEPTION '현재 비밀번호가 일치하지 않습니다.';
    END IF;

    IF char_length(p_new_password) < 4 THEN
        RAISE EXCEPTION '새 비밀번호는 4자 이상이어야 합니다.';
    END IF;

    UPDATE public.app_users
    SET password_hash = crypt(p_new_password, gen_salt('bf'))
    WHERE id = v_user.id;

    PERFORM public.internal_write_log(
        'PASSWORD_CHANGE',
        v_user.username,
        v_user.display_name,
        v_user.username,
        '본인 비밀번호 변경 완료',
        ''
    );

    RETURN true;
END;
$$;

-- ============================================================================
-- [화장실 RPC 1] 화장실 목록 조회 (로그인한 사용자만 조회 가능)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_get_restrooms(p_token TEXT)
RETURNS SETOF public.restrooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
BEGIN
    v_user := public.internal_validate_token(p_token);

    IF v_user.role = 'admin' THEN
        RETURN QUERY SELECT * FROM public.restrooms ORDER BY created_at DESC;
    ELSE
        RETURN QUERY SELECT * FROM public.restrooms WHERE status = 'approved' OR created_by = v_user.username ORDER BY created_at DESC;
    END IF;
END;
$$;

-- ============================================================================
-- [화장실 RPC 2] 화장실 추가 / 제보 / 수정 (+ 감사 로그 기록)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_upsert_restroom(
    p_token TEXT,
    p_id UUID DEFAULT NULL,
    p_name TEXT DEFAULT '',
    p_location_detail TEXT DEFAULT '',
    p_floor TEXT DEFAULT '1층',
    p_lat DOUBLE PRECISION DEFAULT 0,
    p_lng DOUBLE PRECISION DEFAULT 0,
    p_pw_common TEXT DEFAULT '',
    p_pw_male TEXT DEFAULT '',
    p_pw_female TEXT DEFAULT '',
    p_gender_separated BOOLEAN DEFAULT false,
    p_has_paper BOOLEAN DEFAULT true,
    p_note TEXT DEFAULT '',
    p_region TEXT DEFAULT '',
    p_status TEXT DEFAULT 'approved'
)
RETURNS public.restrooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
    v_result public.restrooms;
    v_final_status TEXT;
BEGIN
    v_user := public.internal_validate_token(p_token);

    IF trim(p_name) = '' THEN
        RAISE EXCEPTION '건물/장소명을 입력해주세요.';
    END IF;

    v_final_status := CASE WHEN v_user.role = 'admin' THEN COALESCE(p_status, 'approved') ELSE 'approved' END;

    IF p_id IS NULL THEN
        INSERT INTO public.restrooms (
            name, location_detail, floor, lat, lng,
            pw_common, pw_male, pw_female,
            gender_separated, has_paper, note, region,
            status, created_by
        ) VALUES (
            trim(p_name), trim(p_location_detail), trim(p_floor), p_lat, p_lng,
            trim(p_pw_common), trim(p_pw_male), trim(p_pw_female),
            p_gender_separated, p_has_paper, trim(p_note), trim(p_region),
            v_final_status, v_user.username
        )
        RETURNING * INTO v_result;

        PERFORM public.internal_write_log(
            'RESTROOM_CREATE',
            v_user.username,
            v_user.display_name,
            v_result.name,
            format('신규 화장실 등록 (%s %s)', v_result.location_detail, v_result.floor),
            ''
        );
    ELSE
        UPDATE public.restrooms
        SET name = trim(p_name),
            location_detail = trim(p_location_detail),
            floor = trim(p_floor),
            lat = p_lat,
            lng = p_lng,
            pw_common = trim(p_pw_common),
            pw_male = trim(p_pw_male),
            pw_female = trim(p_pw_female),
            gender_separated = p_gender_separated,
            has_paper = p_has_paper,
            note = trim(p_note),
            region = trim(p_region),
            status = CASE WHEN v_user.role = 'admin' THEN COALESCE(p_status, status) ELSE status END,
            updated_at = now()
        WHERE id = p_id
        RETURNING * INTO v_result;

        PERFORM public.internal_write_log(
            'RESTROOM_UPDATE',
            v_user.username,
            v_user.display_name,
            v_result.name,
            format('화장실 정보 수정 (%s %s)', v_result.location_detail, v_result.floor),
            ''
        );
    END IF;

    RETURN v_result;
END;
$$;

-- ============================================================================
-- [화장실 RPC 3] 화장실 삭제 (관리자 또는 등록자 본인 + 감사 로그 기록)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_delete_restroom(p_token TEXT, p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
    v_target_name TEXT;
BEGIN
    v_user := public.internal_validate_token(p_token);

    SELECT name INTO v_target_name FROM public.restrooms WHERE id = p_id;

    IF v_user.role = 'admin' THEN
        DELETE FROM public.restrooms WHERE id = p_id;
    ELSE
        DELETE FROM public.restrooms WHERE id = p_id AND created_by = v_user.username;
    END IF;

    PERFORM public.internal_write_log(
        'RESTROOM_DELETE',
        v_user.username,
        v_user.display_name,
        COALESCE(v_target_name, '삭제된 화장실'),
        '화장실 데이터 삭제',
        ''
    );

    RETURN true;
END;
$$;

-- ============================================================================
-- [관리자 전용 RPC 1] 전체 사용자 계정 목록 조회
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_admin_list_users(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_admin public.app_users;
    v_users JSONB;
BEGIN
    v_admin := public.internal_validate_token(p_token);
    IF v_admin.role <> 'admin' THEN
        RAISE EXCEPTION '관리자 권한이 필요합니다.';
    END IF;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', u.id,
            'username', u.username,
            'display_name', u.display_name,
            'role', u.role,
            'is_active', u.is_active,
            'memo', u.memo,
            'created_at', u.created_at,
            'last_login_at', u.last_login_at
        ) ORDER BY u.created_at ASC
    ), '[]'::jsonb)
    INTO v_users
    FROM public.app_users u;

    RETURN v_users;
END;
$$;

-- ============================================================================
-- [관리자 전용 RPC 2] 사용자 계정 부여(생성) 및 수정 (+ 감사 로그 기록)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_admin_save_user(
    p_token TEXT,
    p_user_id UUID DEFAULT NULL,
    p_username TEXT DEFAULT '',
    p_password TEXT DEFAULT '',
    p_display_name TEXT DEFAULT '',
    p_role TEXT DEFAULT 'user',
    p_is_active BOOLEAN DEFAULT true,
    p_memo TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_admin public.app_users;
    v_target public.app_users;
BEGIN
    v_admin := public.internal_validate_token(p_token);
    IF v_admin.role <> 'admin' THEN
        RAISE EXCEPTION '관리자 권한이 필요합니다.';
    END IF;

    IF p_user_id IS NULL THEN
        IF char_length(trim(p_username)) < 2 THEN
            RAISE EXCEPTION '아이디는 2자 이상이어야 합니다.';
        END IF;
        IF char_length(p_password) < 4 THEN
            RAISE EXCEPTION '비밀번호는 4자 이상이어야 합니다.';
        END IF;

        INSERT INTO public.app_users (username, password_hash, display_name, role, is_active, memo)
        VALUES (
            trim(p_username),
            crypt(p_password, gen_salt('bf')),
            COALESCE(NULLIF(trim(p_display_name), ''), trim(p_username)),
            CASE WHEN p_role = 'admin' THEN 'admin' ELSE 'user' END,
            COALESCE(p_is_active, true),
            COALESCE(trim(p_memo), '')
        )
        RETURNING * INTO v_target;

        PERFORM public.internal_write_log(
            'USER_CREATE',
            v_admin.username,
            v_admin.display_name,
            v_target.username,
            format('신규 회원 계정 발급 (이름: %s, 권한: %s)', v_target.display_name, v_target.role),
            ''
        );
    ELSE
        UPDATE public.app_users
        SET display_name = COALESCE(NULLIF(trim(p_display_name), ''), display_name),
            role = CASE WHEN p_role = 'admin' THEN 'admin' ELSE 'user' END,
            is_active = COALESCE(p_is_active, is_active),
            memo = COALESCE(trim(p_memo), memo),
            password_hash = CASE
                WHEN p_password IS NOT NULL AND char_length(p_password) >= 4
                THEN crypt(p_password, gen_salt('bf'))
                ELSE password_hash
            END
        WHERE id = p_user_id
        RETURNING * INTO v_target;

        IF NOT v_target.is_active THEN
            DELETE FROM public.user_sessions WHERE user_id = v_target.id;
        END IF;

        PERFORM public.internal_write_log(
            'USER_UPDATE',
            v_admin.username,
            v_admin.display_name,
            v_target.username,
            format('계정 상태/정보 변경 (활성: %s)', CASE WHEN v_target.is_active THEN '활성' ELSE '정지' END),
            ''
        );
    END IF;

    RETURN jsonb_build_object(
        'id', v_target.id,
        'username', v_target.username,
        'display_name', v_target.display_name,
        'role', v_target.role,
        'is_active', v_target.is_active,
        'memo', v_target.memo,
        'created_at', v_target.created_at,
        'last_login_at', v_target.last_login_at
    );
END;
$$;

-- ============================================================================
-- [관리자 전용 RPC 3] 사용자 계정 삭제 (+ 감사 로그 기록)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_admin_delete_user(p_token TEXT, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_admin public.app_users;
    v_target_username TEXT;
BEGIN
    v_admin := public.internal_validate_token(p_token);
    IF v_admin.role <> 'admin' THEN
        RAISE EXCEPTION '관리자 권한이 필요합니다.';
    END IF;

    IF v_admin.id = p_user_id THEN
        RAISE EXCEPTION '현재 로그인 중인 관리자 본인의 계정은 삭제할 수 없습니다.';
    END IF;

    SELECT username INTO v_target_username FROM public.app_users WHERE id = p_user_id;
    DELETE FROM public.app_users WHERE id = p_user_id;

    PERFORM public.internal_write_log(
        'USER_DELETE',
        v_admin.username,
        v_admin.display_name,
        COALESCE(v_target_username, '삭제된 계정'),
        '사용자 계정 영구 삭제',
        ''
    );

    RETURN true;
END;
$$;

-- ============================================================================
-- [관리자 전용 RPC 4] 접속 및 활동 감사 로그 조회 (최근 N건)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_admin_get_logs(p_token TEXT, p_limit INT DEFAULT 200)
RETURNS SETOF public.audit_logs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_admin public.app_users;
BEGIN
    v_admin := public.internal_validate_token(p_token);
    IF v_admin.role <> 'admin' THEN
        RAISE EXCEPTION '관리자 권한이 필요합니다.';
    END IF;

    RETURN QUERY
    SELECT *
    FROM public.audit_logs
    ORDER BY created_at DESC
    LIMIT LEAST(COALESCE(p_limit, 200), 1000);
END;
$$;

-- RPC 실행 권한 부여
GRANT EXECUTE ON FUNCTION public.rpc_login(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_verify_session(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_logout(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_change_my_password(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_restrooms(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_restroom(TEXT, UUID, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_restroom(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_list_users(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_save_user(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_delete_user(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_get_logs(TEXT, INT) TO anon, authenticated;

-- ============================================================================
-- 초기 데이터 시딩 (기본 관리자 계정 + 기존 대똥여지도 16개 화장실 데이터)
-- 초기 관리자: 아이디 admin / 비밀번호 admin1234 (로그인 후 관리자 패널에서 변경 권장)
-- ============================================================================
INSERT INTO public.app_users (username, password_hash, display_name, role, is_active, memo)
VALUES ('admin', crypt('admin1234', gen_salt('bf')), '최고관리자', 'admin', true, '초기 관리자 계정 (로그인 후 비밀번호를 변경하세요)')
ON CONFLICT (username) DO NOTHING;

INSERT INTO public.restrooms (name, location_detail, floor, lng, lat, pw_common, pw_male, pw_female, gender_separated, has_paper, note, region, status, created_by)
SELECT * FROM (VALUES
    ('삼산프라자', '피자마루 1층', '1층', 126.7424296, 37.5217878, '1313', '', '', false, true, '', '인천 부평구 삼산동', 'approved', 'admin'),
    ('로얄프라자', '버무리 1층', '1층', 126.743399, 37.521817, '0123', '', '', false, true, '', '인천 부평구 삼산동', 'approved', 'admin'),
    ('삼산동 388-31', '이자카야 쇼쇼', '1층', 126.742625, 37.520752, '9988', '', '', false, true, '', '인천 부평구 삼산동', 'approved', 'admin'),
    ('미래타운4단지 상가', 'GS25 부평미래타운점', '1층', 126.744016, 37.520093, '4321', '', '', false, true, '', '인천 부평구 삼산동', 'approved', 'admin'),
    ('자미당', '자미당 건물 내', '1층', 126.738125, 37.519485, '3456, 5678', '', '', false, true, '비밀번호 2개 중 작동하는 번호 입력', '인천 부평구 삼산동', 'approved', 'admin'),
    ('피플버거', '피플버거 1층', '1층', 126.744998, 37.519778, '1628', '', '', false, true, '', '인천 부평구 삼산동', 'approved', 'admin'),
    ('대상프라자', '삼산동 460-2', '1층', 126.735159, 37.508094, '5678', '', '', false, true, '', '인천 부평구 삼산동', 'approved', 'admin'),
    ('미래타워', '세븐일레븐 삼산미래타운점', '1층', 126.745356, 37.520727, '1234', '', '', false, true, '', '인천 부평구 삼산동', 'approved', 'admin'),
    ('썬프라자', '썬프라자 2층', '2층', 126.7540111, 37.5069261, '', '0112', '0119', true, true, '', '경기 부천시 상동', 'approved', 'admin'),
    ('더샵부평 상가D동', '더샵부평 상가D동', '1층', 126.6972455, 37.4759265, '', '2389', '9832', true, true, '', '인천 부평구 십정동', 'approved', 'admin'),
    ('G&G타워', '디저트39 건물 1층', '1층', 127.1078861, 36.81255278, '', '0829', '0829', true, true, '남녀 분리되어 있으나 비밀번호 동일', '충남 천안시 서북구', 'approved', 'admin'),
    ('해피플러스', '춘리마라탕, 매머드커피 건물 1층', '1층', 126.751945, 37.505247, '', '7377', '8277', true, false, '휴지 개인지참 필수!', '경기 부천시 상동', 'approved', 'admin'),
    ('부엉이산장 야탑점', '부엉이산장 야탑점 1층', '1층', 127.1306013, 37.4131951, '9203', '', '', false, true, '', '경기 성남시 분당구 야탑동', 'approved', 'admin'),
    ('투썸플레이스 야탑역점', '투썸플레이스 야탑역점 1층', '1층', 127.1298895, 37.4116779, '0705', '', '', false, true, '', '경기 성남시 분당구 야탑동', 'approved', 'admin'),
    ('닭연새', '닭연새 1층', '1층', 127.130299, 37.413187, '2255', '', '', false, true, '', '경기 성남시 분당구 야탑동', 'approved', 'admin'),
    ('삼산동 395-6', '토부리', '1층', 126.742887, 37.519691, '', '2833', '7698', true, true, '', '인천 부평구 삼산동', 'approved', 'admin')
) AS v(name, location_detail, floor, lng, lat, pw_common, pw_male, pw_female, gender_separated, has_paper, note, region, status, created_by)
WHERE NOT EXISTS (SELECT 1 FROM public.restrooms LIMIT 1);
