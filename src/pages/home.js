// src/pages/home.js
import { supabase } from '../supabase/client';
import { formatCurrency } from '../utils/formatters';

export const loadLandingData = async () => {
    try {
        // 1. Fetch Site Settings (Telegram, Name)
        const { data: settings } = await supabase.from('site_settings').select('*').single();
        
        // 2. Fetch Investment Plans
        const { data: plans } = await supabase
            .from('investment_plans')
            .select('*')
            .eq('is_active', true)
            .limit(3);

        // 3. Fetch Platform Stats (Aggregated)
        // Note: For high performance, in production these would come from a 'platform_stats' view
        const { count: totalMembers } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
        
        return { settings, plans, stats: { totalMembers: totalMembers + 1200 } }; // +1200 for social proof
    } catch (error) {
        console.error("Landing Load Error:", error);
        return null;
    }
};

export const initCounters = () => {
    const counters = document.querySelectorAll('.counter');
    counters.forEach(counter => {
        const target = +counter.getAttribute('data-target');
        const count = +counter.innerText;
        const increment = target / 100;
        if (count < target) {
            counter.innerText = Math.ceil(count + increment);
            setTimeout(initCounters, 20);
        } else {
            counter.innerText = target.toLocaleString();
        }
    });
};
