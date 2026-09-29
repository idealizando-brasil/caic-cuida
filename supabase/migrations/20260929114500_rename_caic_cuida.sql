-- Atualiza somente a identificação comercial visível; o código interno é mantido por compatibilidade.
update public.subscription_plans
set name = 'Sistema CUIDA Mensal', updated_at = now()
where code = 'cuida_mensal';
