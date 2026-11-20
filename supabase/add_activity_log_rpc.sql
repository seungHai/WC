-- ============================================================================
-- 대똥여지도 (WC Map) - 사용자 상세 행동 로그 기록용 RPC 함수
-- 사용법: Supabase 대시보드 -> SQL Editor -> New Query 에 붙여넣고 Run 클릭
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rpc_log_activity(
    p_token TEXT,
    p_action_type TEXT,
    p_target_name TEXT DEFAULT '',
    p_detail TEXT DEFAULT '',
    p_device_info TEXT DEFAULT ''
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
    v_action TEXT;
BEGIN
    v_user := public.internal_validate_token(p_token);
    v_action := upper(trim(COALESCE(p_action_type, '')));

    -- 허용된 사용자 행동 이벤트 타입만 기록 (화이트리스트)
    IF v_action NOT IN (
        'VIEW_RESTROOM',
        'COPY_PASSWORD',
        'NAV_CLICK',
        'SEARCH',
        'REGION_CHANGE',
        'FILTER_CHANGE',
        'PUBLIC_TOGGLE',
        'URGENT_NEAREST',
        'SHARE_RESTROOM'
    ) THEN
        RETURN false;
    END IF;

    PERFORM public.internal_write_log(
        v_action,
        v_user.username,
        v_user.display_name,
        left(trim(COALESCE(p_target_name, '')), 120),
        left(trim(COALESCE(p_detail, '')), 300),
        left(trim(COALESCE(p_device_info, '')), 300)
    );

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_log_activity(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
