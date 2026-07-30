import { supabase } from '../api/supabase'

document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const refCode = urlParams.get('code');
    if (refCode) {
        document.getElementById('referralCode').value = refCode;
    }

    const registerForm = document.getElementById('registerForm');
    
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('regBtn');
        btn.innerText = "Processing...";
        btn.disabled = true;

        const fullName = document.getElementById('fullName').value;
        const phone = document.getElementById('phone').value;
        const password = document.getElementById('password').value;
        const referredBy = document.getElementById('referralCode').value;

        // Supabase Auth (Using phone as email-like identifier for simplicity in this stack)
        // Note: Supabase requires an email format, so we use phone@velora.com internally
        const { data, error } = await supabase.auth.signUp({
            email: `${phone}@velora.com`,
            password: password,
            options: {
                data: {
                    full_name: fullName,
                    phone_number: phone,
                    referred_by: referredBy
                }
            }
        });

        if (error) {
            alert("Registration Failed: " + error.message);
            btn.innerText = "Create Account";
            btn.disabled = false;
        } else {
            alert("Welcome to VELORA! ₦600 bonus added.");
            window.location.href = '/dashboard';
        }
    });
});
