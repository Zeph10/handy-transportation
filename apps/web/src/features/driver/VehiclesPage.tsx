import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { VEHICLE_TYPES, validateVehicle } from '@handy/core';
import { Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, Loading, Notice, PageHeader, Select, Textarea, useConfirm, useToast } from '@/components/ui';
import { archiveVehicle, saveVehicle } from '@/lib/api';
import { toAppError } from '@/lib/errors';
import type { VehicleRow } from '@/lib/types';
import { useUserId } from '@/features/auth/session';
import { qk, useDriverReference } from './hooks';

const TYPE_LABEL: Record<string, string> = { SEDAN: 'Sedan', SUV: 'SUV', VAN: 'Van', SPRINTER: 'Sprinter', MINIBUS: 'Minibus', OTHER: 'Other' };

export function VehiclesPage() {
  const driverId = useUserId();
  const ref = useDriverReference(driverId);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<VehicleRow | 'new' | null>(null);

  const archive = async (v: VehicleRow) => {
    if (!(await confirm({ title: `Remove ${v.name}?`, body: 'It will no longer be offered for new availability. Past availability keeps its vehicle.', confirmLabel: 'Remove', danger: true }))) return;
    try { await archiveVehicle(v.id, v.version); toast('success', 'Vehicle removed'); await qc.invalidateQueries({ queryKey: qk.vehicles(driverId) }); }
    catch (e) { toast('error', toAppError(e).message); }
  };

  return (
    <div>
      <PageHeader title="Vehicles" subtitle="Passenger capacity for each trip comes from the vehicle you pick for that time." actions={<Button onClick={() => setEditing('new')}>+ Add vehicle</Button>} />
      {ref.loading ? <Loading /> : ref.vehicles.length === 0 ? (
        <EmptyState title="No vehicles yet" action={<Button onClick={() => setEditing('new')}>Add your first vehicle</Button>}>You need at least one vehicle before sharing availability.</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {ref.vehicles.map((v) => (
            <li key={v.id}>
              <Card>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{v.name} {v.is_default && <Badge tone="blue">Default</Badge>} {!v.is_active && <Badge>Inactive</Badge>}</p>
                    <p className="text-sm text-[var(--muted)]">{[TYPE_LABEL[v.vehicle_type], v.make_model].filter(Boolean).join(' · ')}</p>
                    <p className="mt-2 text-sm"><strong>{v.max_passengers}</strong> passengers · <strong>{v.max_luggage ?? '–'}</strong> large bags</p>
                    {v.accessibility_notes && <p className="mt-1 text-sm">♿ {v.accessibility_notes}</p>}
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button variant="outline" size="sm" onClick={() => setEditing(v)}>Edit</Button>
                    <Button variant="ghost" size="sm" onClick={() => void archive(v)}>Remove</Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <VehicleDialog vehicle={editing} onClose={() => setEditing(null)} onSaved={() => qc.invalidateQueries({ queryKey: qk.vehicles(driverId) })} />
    </div>
  );
}

function VehicleDialog({ vehicle, onClose, onSaved }: { vehicle: VehicleRow | 'new' | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', make_model: '', vehicle_type: 'SEDAN', max_passengers: '3', max_luggage: '3', accessibility_notes: '', is_active: true, is_default: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!vehicle) return;
    setErrors({});
    if (vehicle === 'new') setF({ name: '', make_model: '', vehicle_type: 'SEDAN', max_passengers: '3', max_luggage: '3', accessibility_notes: '', is_active: true, is_default: false });
    else setF({
      name: vehicle.name, make_model: vehicle.make_model ?? '', vehicle_type: vehicle.vehicle_type, max_passengers: String(vehicle.max_passengers),
      max_luggage: vehicle.max_luggage == null ? '' : String(vehicle.max_luggage), accessibility_notes: vehicle.accessibility_notes ?? '',
      is_active: vehicle.is_active, is_default: vehicle.is_default,
    });
  }, [vehicle]);

  const save = async () => {
    const input = {
      name: f.name.trim(), makeModel: f.make_model.trim() || null, vehicleType: f.vehicle_type,
      maxPassengers: Number(f.max_passengers), maxLuggage: f.max_luggage === '' ? null : Number(f.max_luggage),
    };
    const errs = validateVehicle(input);
    setErrors(Object.fromEntries(errs.map((e) => [e.field, e.message])));
    if (errs.length || !vehicle) return;
    setBusy(true);
    try {
      await saveVehicle({
        name: input.name, make_model: input.makeModel, vehicle_type: f.vehicle_type as VehicleRow['vehicle_type'], max_passengers: input.maxPassengers,
        max_luggage: input.maxLuggage, accessibility_notes: f.accessibility_notes.trim() || null, is_active: f.is_active, is_default: f.is_default,
      }, vehicle === 'new' ? undefined : vehicle.id, vehicle === 'new' ? undefined : vehicle.version);
      toast('success', 'Vehicle saved');
      await onSaved();
      onClose();
    } catch (e) { setErrors({ form: toAppError(e).message }); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={!!vehicle} onClose={onClose} title={vehicle === 'new' ? 'Add vehicle' : 'Edit vehicle'}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Name" htmlFor="v-name" required error={errors.name} help="What you call it, e.g. Black Suburban"><Input id="v-name" value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" htmlFor="v-type" error={errors.vehicleType}>
            <Select id="v-type" value={f.vehicle_type} onChange={(e) => setF({ ...f, vehicle_type: e.target.value })}>
              {VEHICLE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </Select>
          </Field>
          <Field label="Make / model" htmlFor="v-mm"><Input id="v-mm" value={f.make_model} maxLength={120} onChange={(e) => setF({ ...f, make_model: e.target.value })} /></Field>
          <Field label="Max passengers" htmlFor="v-pax" required error={errors.maxPassengers}><Input id="v-pax" type="number" inputMode="numeric" min={1} max={60} value={f.max_passengers} onChange={(e) => setF({ ...f, max_passengers: e.target.value })} /></Field>
          <Field label="Max large bags" htmlFor="v-lug" error={errors.maxLuggage}><Input id="v-lug" type="number" inputMode="numeric" min={0} max={100} value={f.max_luggage} onChange={(e) => setF({ ...f, max_luggage: e.target.value })} /></Field>
        </div>
        <Field label="Accessibility (optional)" htmlFor="v-acc" help="e.g. wheelchair ramp, child seats available"><Textarea id="v-acc" value={f.accessibility_notes} maxLength={500} onChange={(e) => setF({ ...f, accessibility_notes: e.target.value })} /></Field>
        <Checkbox label="Default vehicle" description="Pre-selected when you add availability" checked={f.is_default} onChange={(v) => setF({ ...f, is_default: v })} />
        <Checkbox label="Active" description="Inactive vehicles are hidden when adding availability" checked={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} />
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
      </div>
    </Dialog>
  );
}
