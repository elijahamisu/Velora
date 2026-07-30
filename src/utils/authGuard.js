import { supabase } from '../api/supabase'

export const checkSession = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
        window.location.href = '/login.html';
        return null;
    }
    
    return session.user;
};

export const logout = async () => {
    await supabase.auth.signOut();
    window.location.href = '/login.html';
};
