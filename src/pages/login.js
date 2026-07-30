import { supabase } from '../api/supabase'

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('loginBtn');
        btn.innerText = "Authenticating...";
        btn.disabled = true;

        const phone = document.getElementById('phone').value;
        const password = document.getElementById('password').value;

        // Sign in using the virtual email created during registration
        const { data, error } = await supabase.auth.signInWithPassword({
            email: `${phone}@velora.com`,
            password: password,
        });

        if (error) {
            alert("Login Failed: Invalid credentials or network error.");
            btn.innerText = "Sign In";
            btn.disabled = false;
        } else {
            // Success! Store user in session and redirect
            window.location.href = '/dashboard.html';
        }
    });
});
