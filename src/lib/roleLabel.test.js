import { describe, it, expect } from 'vitest';
import { roleLabelFor } from './roleLabel';

// Every case is a real Langley combination (platform role × centre title).
describe('roleLabelFor', () => {
  it('calls a Host a Host, not an Instructor', () => {
    // Rahul: platform role instructor, Langley title Host.
    expect(roleLabelFor({ platformRole: 'instructor', instructorType: 'Host' })).toBe('Host');
  });

  it('shows the centre title for Leads, Managers, Directors and the admin assistant', () => {
    expect(roleLabelFor({ platformRole: 'instructor', instructorType: 'Lead' })).toBe('Lead');
    expect(roleLabelFor({ platformRole: 'instructor', instructorType: 'Training' })).toBe('Training');
    expect(roleLabelFor({ platformRole: 'admin', instructorType: 'Manager' })).toBe('Manager');
    expect(roleLabelFor({ platformRole: 'director', instructorType: 'Center Director' })).toBe('Center Director');
    expect(roleLabelFor({ platformRole: 'director', instructorType: 'Dir. of Education' })).toBe('Dir. of Education');
    expect(roleLabelFor({ platformRole: 'admin_assistant', instructorType: 'Admin' })).toBe('Admin');
  });

  it('keeps Owner and Enterprise over a leftover "Instructor" title', () => {
    expect(roleLabelFor({ platformRole: 'owner', instructorType: 'Instructor' })).toBe('Owner');
    expect(roleLabelFor({ platformRole: 'super_admin', instructorType: 'instructor' })).toBe('Enterprise');
  });

  it('falls back to the platform role when the title is plain Instructor or missing', () => {
    expect(roleLabelFor({ platformRole: 'admin', instructorType: 'Instructor' })).toBe('Admin');
    expect(roleLabelFor({ platformRole: 'director' })).toBe('Director');
    expect(roleLabelFor({ platformRole: 'instructor', instructorType: 'Instructor' })).toBe('Instructor');
    expect(roleLabelFor({ platformRole: 'instructor', instructorType: '  ' })).toBe('Instructor');
  });

  it('says Volunteer before anything else', () => {
    expect(roleLabelFor({ platformRole: 'instructor', instructorType: 'Volunteer', isVolunteer: true })).toBe('Volunteer');
    expect(roleLabelFor({ platformRole: 'instructor', instructorType: 'Instructor', isVolunteer: true })).toBe('Volunteer');
  });

  it('copes with nothing loaded yet', () => {
    expect(roleLabelFor()).toBe('Instructor');
  });
});
