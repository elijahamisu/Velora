// Example: src/services/walletService.js
import { supabase } from '../supabase/client';

export const walletService = {
    async getBalance(userId) {
        const { data, error } = await supabase
            .from('wallets')
            .select('*')
            .eq('user_id', userId)
            .single();
        if (error) throw error;
        return data;
    },
    
    async getTransactions(userId) {
        const { data, error } = await supabase
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        return { data, error };
    }
};
