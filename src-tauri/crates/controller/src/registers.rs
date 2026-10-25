//! 寄存器枚举与高层指令帧构造（对齐《核心板控制软件要求》2.8.4）。

use crate::protocol::{encode, OpCode};

/// 寄存器：DMX 核心板操作（复位/出厂/测试）。
pub const REG_BOARD_OP: u16 = 0x0000;
/// 寄存器：通道读写。
pub const REG_CHANNEL: u16 = 0x0001;
/// 寄存器：节目文件操作。
pub const REG_PROGRAM: u16 = 0x0002;
/// 寄存器：工作模式。
pub const REG_WORKMODE: u16 = 0x0003;

/// 核心板操作码（寄存器 0x0000）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BoardOp {
    /// 复位。
    Reset = 0,
    /// 出厂初始化。
    Factory = 1,
    /// 测试。
    Test = 2,
}

impl TryFrom<u8> for BoardOp {
    type Error = ();

    /// 由值还原核心板操作码；超出 0~2 返回 `Err(())`。
    fn try_from(v: u8) -> Result<Self, ()> {
        Ok(match v {
            0 => Self::Reset,
            1 => Self::Factory,
            2 => Self::Test,
            _ => return Err(()),
        })
    }
}

/// 节目文件操作（寄存器 0x0002）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ProgramAction {
    /// 停止。
    Stop = 0,
    /// 暂停。
    Pause = 1,
    /// 单次播放。
    PlayOnce = 2,
    /// 循环播放。
    Loop = 3,
    /// 删除。
    Delete = 4,
    /// 录制。
    Record = 5,
}

impl TryFrom<u8> for ProgramAction {
    type Error = ();

    /// 由值还原节目操作；超出 0~5 返回 `Err(())`。
    fn try_from(v: u8) -> Result<Self, ()> {
        Ok(match v {
            0 => Self::Stop,
            1 => Self::Pause,
            2 => Self::PlayOnce,
            3 => Self::Loop,
            4 => Self::Delete,
            5 => Self::Record,
            _ => return Err(()),
        })
    }
}

/// DMX 核心板工作模式（寄存器 0x0003）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum WorkMode {
    /// 自动模式。
    Auto = 0,
    /// Art-Net 转发模式。
    ArtnetForward = 1,
    /// 回路环境模式。
    LoopEnv = 2,
    /// 场景模式。
    Scene = 3,
    /// 节目模式。
    Program = 4,
    /// 效果模式。
    Effect = 5,
}

impl WorkMode {
    /// 由值还原工作模式。
    ///
    /// # Arguments
    ///
    /// * `v` - 0~5 的模式值。
    ///
    /// # Returns
    ///
    /// 对应 [`WorkMode`]；超出范围返回 `None`。
    #[must_use]
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::Auto,
            1 => Self::ArtnetForward,
            2 => Self::LoopEnv,
            3 => Self::Scene,
            4 => Self::Program,
            5 => Self::Effect,
            _ => return None,
        })
    }
}

/// 构造核心板操作帧（复位/出厂/测试，需确认）。
#[must_use]
pub fn board_op(op: BoardOp) -> Vec<u8> {
    encode(OpCode::SetConfirm, REG_BOARD_OP, &[op as u8])
}

/// 构造设置工作模式帧（需确认）。
#[must_use]
pub fn set_work_mode(mode: WorkMode) -> Vec<u8> {
    encode(OpCode::SetConfirm, REG_WORKMODE, &[mode as u8])
}

/// 构造读取工作模式帧（get）。
#[must_use]
pub fn get_work_mode() -> Vec<u8> {
    encode(OpCode::Get, REG_WORKMODE, &[])
}

/// 构造节目文件操作帧（需确认）。
///
/// # Arguments
///
/// * `program_no` - 节目号。
/// * `action` - 操作。
#[must_use]
pub fn program_op(program_no: u8, action: ProgramAction) -> Vec<u8> {
    encode(OpCode::SetConfirm, REG_PROGRAM, &[program_no, action as u8])
}

/// 构造写通道帧（需确认）。
///
/// # Arguments
///
/// * `start` - 起始通道 A。
/// * `unit_count` - 单元数量 B。
/// * `unit_run` - 单元连续数量 N。
/// * `values` - 通道值序列。
#[must_use]
pub fn write_channels(start: u8, unit_count: u8, unit_run: u8, values: &[u8]) -> Vec<u8> {
    let mut data = Vec::with_capacity(3 + values.len());
    data.push(start);
    data.push(unit_count);
    data.push(unit_run);
    data.extend_from_slice(values);
    encode(OpCode::SetConfirm, REG_CHANNEL, &data)
}

/// 构造读通道帧（get）。
///
/// # Arguments
///
/// * `start` - 起始通道 A。
/// * `unit_count` - 单元数量 B。
/// * `unit_run` - 单元连续数量 N。
#[must_use]
pub fn read_channels(start: u8, unit_count: u8, unit_run: u8) -> Vec<u8> {
    encode(OpCode::Get, REG_CHANNEL, &[start, unit_count, unit_run])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{decode, OpCode};

    #[test]
    fn set_work_mode_frame() {
        let f = decode(&set_work_mode(WorkMode::Program)).unwrap();
        assert_eq!(f.register, REG_WORKMODE);
        assert_eq!(f.opcode, OpCode::SetConfirm);
        assert_eq!(f.data, vec![4]);
    }

    #[test]
    fn program_op_frame() {
        let f = decode(&program_op(3, ProgramAction::Loop)).unwrap();
        assert_eq!(f.register, REG_PROGRAM);
        assert_eq!(f.data, vec![3, 3]);
    }

    #[test]
    fn write_channels_frame() {
        let f = decode(&write_channels(1, 5, 4, &[10, 20, 30])).unwrap();
        assert_eq!(f.register, REG_CHANNEL);
        assert_eq!(f.data, vec![1, 5, 4, 10, 20, 30]);
    }

    #[test]
    fn board_op_reset_frame() {
        let f = decode(&board_op(BoardOp::Reset)).unwrap();
        assert_eq!(f.register, REG_BOARD_OP);
        assert_eq!(f.data, vec![0]);
    }

    #[test]
    fn work_mode_from_u8() {
        assert_eq!(WorkMode::from_u8(1), Some(WorkMode::ArtnetForward));
        assert_eq!(WorkMode::from_u8(9), None);
    }

    #[test]
    fn board_op_try_from() {
        assert_eq!(BoardOp::try_from(0), Ok(BoardOp::Reset));
        assert_eq!(BoardOp::try_from(2), Ok(BoardOp::Test));
        assert_eq!(BoardOp::try_from(3), Err(()));
    }

    #[test]
    fn program_action_try_from() {
        assert_eq!(ProgramAction::try_from(0), Ok(ProgramAction::Stop));
        assert_eq!(ProgramAction::try_from(5), Ok(ProgramAction::Record));
        assert_eq!(ProgramAction::try_from(6), Err(()));
    }
}
