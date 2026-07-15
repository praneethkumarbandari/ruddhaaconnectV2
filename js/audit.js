/**
 * Shared audit trail logger. Every module that posts, cancels, reverses,
 * or changes financial configuration (account mapping, numbering) should
 * call this. Writes to accounting_audit_log — never blocks the caller's
 * main action if logging itself fails (a missing audit row is bad, but
 * should not be allowed to abort a real transaction).
 */
(function(){
    async function logAudit(moduleName, recordId, actionType, oldValue, newValue){
        try{
            const emp = (window.Auth && window.Auth.getEmployee && window.Auth.getEmployee()) ||
                        JSON.parse(localStorage.getItem('loggedEmployee')||'null');
            await window.db.from('accounting_audit_log').insert([{
                module_name: moduleName,
                record_id: String(recordId),
                action_type: actionType,
                old_value: oldValue!=null ? JSON.stringify(oldValue) : null,
                new_value: newValue!=null ? JSON.stringify(newValue) : null,
                changed_by: emp ? (emp.employee_name||emp.username||emp.email) : 'unknown',
                changed_at: new Date().toISOString(),
            }]);
        }catch(e){
            console.warn('Audit log write failed (action still proceeded):', e);
        }
    }
    window.Audit = { log: logAudit };
})();
