// Backend guards remain authoritative. This mirror also protects local timers.
let allowed = false;
export const canEdit = () => allowed;
export const setEditingAllowed = (value: boolean) => { allowed = value; };
